// Playtests: starting and stopping the editor playtest, and automated test
// runs that play the level with planned inputs and report where the player
// died. The test runner is adapted from GD AI Bridge by RibomDev (MIT, see
// THIRD_PARTY.md).
#include "Rpc.hpp"

#include "../GameThread.hpp"

#include <Geode/modify/GJBaseGameLayer.hpp>
#include <Geode/modify/PlayerObject.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>

using namespace geode::prelude;

namespace gdforge::rpc {

    namespace {
        struct Input {
            double press;
            // Player x where the button is let go; below 0 releases on the next physics step (a tap)
            double release;
        };

        struct TestRun {
            bool active = false;
            bool finished = false;
            std::vector<Input> inputs;
            size_t next = 0;
            bool holding = false;
            double untilX = 0;
            double startX = 0;
            double nextPathX = 0;
            double pathStep = 30;
            double timeout = 120;
            // "x,y;" per pathStep of x, in level coordinates. A string keeps long paths cheap to read.
            std::string path;
            std::string outcome;
            // Player position after the latest physics step, and where the run ended, in layer coordinates
            CCPoint lastPos;
            CCPoint endPos;
            std::chrono::steady_clock::time_point started;
            float oldTimeScale = 1;
        };

        TestRun s_run;

        bool isEditorGame(GJBaseGameLayer* layer) {
            return layer == static_cast<GJBaseGameLayer*>(LevelEditorLayer::get()) && layer->m_player1;
        }

        void finish(std::string outcome, CCPoint pos) {
            if (!s_run.active) return;
            s_run.active = false;
            s_run.finished = true;
            s_run.outcome = std::move(outcome);
            s_run.endPos = pos;
            CCDirector::get()->getScheduler()->setTimeScale(s_run.oldTimeScale);
            // Stopping the playtest from inside the game's own update would pull the level out from under it
            runOnGameThread([] {
                auto layer = LevelEditorLayer::get();
                if (layer && layer->m_editorUI && layer->m_playbackMode != PlaybackMode::Not) {
                    layer->m_editorUI->onStopPlaytest(nullptr);
                }
            });
        }

        // Press and release the planned inputs at the player's current x.
        void beforeStep(GJBaseGameLayer* layer) {
            if (!s_run.active || !isEditorGame(layer)) return;
            double x = layer->m_player1->getPositionX();
            if (s_run.holding) {
                auto const& input = s_run.inputs[s_run.next];
                if (input.release < 0 || x >= input.release) {
                    layer->handleButton(false, 1, true);
                    s_run.holding = false;
                    s_run.next++;
                }
            }
            if (!s_run.holding && s_run.next < s_run.inputs.size() && x >= s_run.inputs[s_run.next].press) {
                layer->handleButton(true, 1, true);
                s_run.holding = true;
            }
        }

        // Record the path and end the run once the player reaches the goal.
        void afterStep(GJBaseGameLayer* layer) {
            if (!s_run.active || !isEditorGame(layer)) return;
            auto pos = layer->m_player1->getPosition();
            s_run.lastPos = pos;
            while (pos.x >= s_run.nextPathX) {
                auto point = toLevel(pos);
                s_run.path += fmt::format("{:.0f},{:.0f};", point.x, point.y);
                s_run.nextPathX += s_run.pathStep;
            }
            if (pos.x >= s_run.untilX) finish("passed", pos);
        }

        // Solid objects close to where the player died, most likely the cause.
        matjson::Value objectsNear(LevelEditorLayer* layer, CCPoint pos) {
            std::vector<std::pair<float, GameObject*>> nearby;
            for (auto object : CCArrayExt<GameObject*>(layer->m_objects)) {
                if (object->m_isDecoration || object->m_isTrigger || object->m_isNoTouch) continue;
                auto distance = ccpDistance(object->getPosition(), pos);
                if (distance <= 45) nearby.emplace_back(distance, object);
            }
            std::sort(nearby.begin(), nearby.end(), [](auto& a, auto& b) { return a.first < b.first; });
            auto list = matjson::Value::array();
            for (size_t i = 0; i < nearby.size() && i < 4; i++) {
                auto object = nearby[i].second;
                auto point = toLevel(object->getPosition());
                list.push(matjson::makeObject({
                    { "uid", object->m_uniqueID },
                    { "id", object->m_objectID },
                    { "x", std::round(point.x) },
                    { "y", std::round(point.y) },
                }));
            }
            return list;
        }

        RpcResult playtest(bool start) {
            GEODE_UNWRAP_INTO(auto editor, requireEditor());
            auto playing = editor.layer->m_playbackMode != PlaybackMode::Not;
            if (start && !playing) editor.ui->onPlaytest(nullptr);
            if (!start && playing) editor.ui->onStopPlaytest(nullptr);
            return Ok(matjson::makeObject({ { "playtesting", editor.layer->m_playbackMode != PlaybackMode::Not } }));
        }

        // Ends a running test the game stopped without us (the user pressed stop, left the editor...)
        // or that ran out of time.
        void checkRun() {
            if (!s_run.active) return;
            auto layer = LevelEditorLayer::get();
            auto player = layer ? layer->m_player1 : nullptr;
            auto pos = player ? player->getPosition() : s_run.lastPos;
            if (!layer || layer->m_playbackMode == PlaybackMode::Not) {
                finish(player && player->m_isDead ? "died" : "stopped", pos);
                return;
            }
            auto elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - s_run.started).count();
            if (elapsed > s_run.timeout) finish("timeout", pos);
        }

        RpcResult testStart(matjson::Value const& params) {
            GEODE_UNWRAP_INTO(auto editor, requireEditor());
            checkRun();
            if (s_run.active) return fail("test_running", "A test is already running.");
            if (editor.layer->m_playbackMode != PlaybackMode::Not) editor.ui->onStopPlaytest(nullptr);

            std::vector<Input> inputs;
            if (params["inputs"].isArray()) {
                for (auto const& item : params["inputs"]) {
                    auto press = item.isObject() ? optNumber(item["x"]) : optNumber(item);
                    if (!press) continue;
                    auto release = item.isObject() ? optNumber(item["release"]) : std::nullopt;
                    inputs.push_back({ *press, release.value_or(-1) });
                }
            }
            std::sort(inputs.begin(), inputs.end(), [](auto& a, auto& b) { return a.press < b.press; });

            // Default goal: a bit past the last gameplay object
            double lastObjectX = 0;
            for (auto object : CCArrayExt<GameObject*>(editor.layer->m_objects)) {
                if (!object->m_isDecoration && !object->m_isTrigger) {
                    lastObjectX = std::max<double>(lastObjectX, object->getPositionX());
                }
            }

            s_run = TestRun {};
            s_run.inputs = std::move(inputs);
            s_run.untilX = optNumber(params["untilX"]).value_or(lastObjectX + 90);
            // Finer sampling helps measure jumps; coarser keeps the reply short
            s_run.pathStep = std::clamp(optNumber(params["pathStep"]).value_or(30), 5.0, 300.0);
            s_run.timeout = std::clamp(optNumber(params["timeout"]).value_or(120), 1.0, 600.0);
            s_run.started = std::chrono::steady_clock::now();

            // Faster than real time, within the range GD's physics stays stable in
            auto speed = std::clamp(optNumber(params["speed"]).value_or(1), 0.25, 4.0);
            auto scheduler = CCDirector::get()->getScheduler();
            s_run.oldTimeScale = scheduler->getTimeScale();
            scheduler->setTimeScale(static_cast<float>(speed));

            editor.ui->onPlaytest(nullptr);
            s_run.startX = editor.layer->m_player1 ? editor.layer->m_player1->getPositionX() : 0;
            s_run.nextPathX = s_run.startX;
            s_run.active = true;
            return Ok(matjson::makeObject({ { "started", true }, { "untilX", s_run.untilX } }));
        }

        RpcResult testPoll(matjson::Value const&) {
            checkRun();
            if (s_run.active) return Ok(matjson::makeObject({ { "running", true } }));
            if (!s_run.finished) return fail("no_test", "No test has been run.");

            auto end = toLevel(s_run.endPos);
            auto length = s_run.untilX - s_run.startX;
            auto progress = length > 0 ? std::clamp((s_run.endPos.x - s_run.startX) / length * 100, 0.0, 100.0) : 0.0;
            auto result = matjson::makeObject({
                { "running", false },
                { "result", s_run.outcome },
                { "x", std::round(end.x) },
                { "y", std::round(end.y) },
                { "progressPercent", std::round(progress) },
                { "inputsUsed", static_cast<int>(s_run.next) },
                { "path", s_run.path },
            });
            auto layer = LevelEditorLayer::get();
            if (s_run.outcome == "died" && layer) result["objectsNearDeath"] = objectsNear(layer, s_run.endPos);
            return Ok(result);
        }
    }

    void registerPlaytest(RpcRegistry& registry) {
        registry["playtest.start"] = [](matjson::Value const&) { return playtest(true); };
        registry["playtest.stop"] = [](matjson::Value const&) { return playtest(false); };
        registry["test.start"] = testStart;
        registry["test.poll"] = testPoll;
    }

}

// Runs every physics step of a playtest
class $modify(GJBaseGameLayer) {
    void processCommands(float dt, bool isHalfTick, bool isLastTick) {
        gdforge::rpc::beforeStep(this);
        GJBaseGameLayer::processCommands(dt, isHalfTick, isLastTick);
        gdforge::rpc::afterStep(this);
    }
};

class $modify(PlayerObject) {
    void playerDestroyed(bool noEffects) {
        auto layer = LevelEditorLayer::get();
        if (gdforge::rpc::s_run.active && layer && static_cast<PlayerObject*>(this) == layer->m_player1) {
            gdforge::rpc::finish("died", this->getPosition());
        }
        PlayerObject::playerDestroyed(noEffects);
    }
};
