// Playtests: starting and stopping the editor playtest, and automated test
// runs that play the level with planned inputs and report where the player
// died. The test runner is adapted from GD AI Bridge by RibomDev (MIT, see
// THIRD_PARTY.md).
#include "Rpc.hpp"

#include "../GameThread.hpp"

#include <Geode/modify/GJBaseGameLayer.hpp>
#include <Geode/modify/PlayerObject.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <optional>

using namespace geode::prelude;

namespace gdforge::rpc {

    namespace {
        struct Input {
            // Pressed at a time (seconds since the run started) or at a player x
            bool byTime;
            double press;
            // When or where it is let go, in the same unit; none lets go on the next physics step (a tap)
            std::optional<double> release;
        };

        // The inputs of one button, played one after another. Buttons are independent,
        // so the player can run right while jumping.
        struct ButtonQueue {
            // As GJBaseGameLayer::handleButton numbers them: 1 jump, 2 left, 3 right
            int button;
            std::vector<Input> inputs;
            size_t next = 0;
            bool holding = false;
        };

        struct TestRun {
            bool active = false;
            bool finished = false;
            std::array<ButtonQueue, 3> queues { ButtonQueue { 1 }, ButtonQueue { 2 }, ButtonQueue { 3 } };
            // Ends the run as passed once the player reaches it
            std::optional<double> untilX;
            // Ends the run as ended after this many seconds of game time
            std::optional<double> duration;
            double startX = 0;
            // The game's clock at the first physics step, and seconds of game time since then
            std::optional<double> clockStart;
            double time = 0;
            double nextPathTime = 0;
            double pathEvery = 0.1;
            double timeout = 120;
            // "t,x,y;" every pathEvery seconds, in level coordinates, skipping points where the
            // player has not moved. A string keeps long paths cheap to read.
            std::string path;
            std::string lastPoint;
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
            // A button still held would stay held in the user's next playtest
            auto layer = LevelEditorLayer::get();
            for (auto& queue : s_run.queues) {
                if (queue.holding && layer && layer->m_playbackMode != PlaybackMode::Not) {
                    layer->handleButton(false, queue.button, true);
                }
                queue.holding = false;
            }
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

        // Press and release the planned inputs at the current time and player x.
        void beforeStep(GJBaseGameLayer* layer) {
            if (!s_run.active || !isEditorGame(layer)) return;
            // Game time, so it follows the test speed and the level's own time warps
            auto clock = layer->m_gameState.m_totalTime;
            if (!s_run.clockStart) s_run.clockStart = clock;
            s_run.time = clock - *s_run.clockStart;

            double x = layer->m_player1->getPositionX();
            auto reached = [&](Input const& input, double value) { return (input.byTime ? s_run.time : x) >= value; };
            for (auto& queue : s_run.queues) {
                if (queue.holding) {
                    auto const& input = queue.inputs[queue.next];
                    if (!input.release || reached(input, *input.release)) {
                        layer->handleButton(false, queue.button, true);
                        queue.holding = false;
                        queue.next++;
                    }
                }
                if (!queue.holding && queue.next < queue.inputs.size()) {
                    auto const& input = queue.inputs[queue.next];
                    if (reached(input, input.press)) {
                        layer->handleButton(true, queue.button, true);
                        queue.holding = true;
                    }
                }
            }
        }

        // Record the path and end the run once the player reaches the goal or the time is up.
        void afterStep(GJBaseGameLayer* layer) {
            if (!s_run.active || !isEditorGame(layer)) return;
            auto pos = layer->m_player1->getPosition();
            s_run.lastPos = pos;
            if (s_run.time >= s_run.nextPathTime) {
                auto point = toLevel(pos);
                auto xy = fmt::format("{:.0f},{:.0f}", point.x, point.y);
                // A player standing still adds nothing; the time of the next point shows when it moved
                if (xy != s_run.lastPoint) {
                    s_run.path += fmt::format("{:.2f},{};", s_run.time, xy);
                    s_run.lastPoint = std::move(xy);
                }
                s_run.nextPathTime = (std::floor(s_run.time / s_run.pathEvery) + 1) * s_run.pathEvery;
            }
            if (s_run.untilX && pos.x >= *s_run.untilX) finish("passed", pos);
            else if (s_run.duration && s_run.time >= *s_run.duration) finish("ended", pos);
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

            s_run = TestRun {};
            if (params["inputs"].isArray()) {
                for (auto const& item : params["inputs"]) {
                    // A bare number is a jump at that x
                    auto button = item.isObject() ? item["button"].asString().unwrapOr("jump") : std::string("jump");
                    auto queue = button == "jump" ? 0 : button == "left" ? 1 : button == "right" ? 2 : -1;
                    if (queue < 0) return fail("bad_params", "\"button\" must be jump, left or right");
                    auto byTime = item.isObject() && !item["t"].isNull();
                    auto press = item.isObject() ? optNumber(byTime ? item["t"] : item["x"]) : optNumber(item);
                    if (!press) continue;
                    auto release = item.isObject() ? optNumber(item["release"]) : std::nullopt;
                    s_run.queues[queue].inputs.push_back({ byTime, *press, release });
                }
            }
            for (auto& queue : s_run.queues) {
                auto& inputs = queue.inputs;
                // In press order, unless times and positions are mixed: those keep the order given
                auto sameUnit = std::all_of(inputs.begin(), inputs.end(), [&](Input const& input) {
                    return input.byTime == inputs.front().byTime;
                });
                if (sameUnit) {
                    std::stable_sort(inputs.begin(), inputs.end(), [](auto& a, auto& b) { return a.press < b.press; });
                }
            }

            // Default goal in classic: a bit past the last gameplay object. A platformer
            // level has no direction to finish in, so it plays for a while instead.
            if (auto untilX = optNumber(params["untilX"])) {
                s_run.untilX = *untilX;
            }
            else if (!editor.layer->m_levelSettings->m_platformerMode) {
                double lastObjectX = 0;
                for (auto object : CCArrayExt<GameObject*>(editor.layer->m_objects)) {
                    if (!object->m_isDecoration && !object->m_isTrigger) {
                        lastObjectX = std::max<double>(lastObjectX, object->getPositionX());
                    }
                }
                s_run.untilX = lastObjectX + 90;
            }
            if (auto duration = optNumber(params["duration"])) {
                s_run.duration = std::clamp(*duration, 0.1, 600.0);
            }
            else if (!s_run.untilX) {
                // Play the timed inputs out, then watch what happens for two more seconds
                double last = 0;
                for (auto const& queue : s_run.queues) {
                    for (auto const& input : queue.inputs) {
                        if (input.byTime) last = std::max(last, input.release.value_or(input.press));
                    }
                }
                s_run.duration = last + 2;
            }
            // Finer sampling helps measure jumps; coarser keeps the reply short
            s_run.pathEvery = std::clamp(optNumber(params["pathEvery"]).value_or(0.1), 0.02, 2.0);
            s_run.timeout = std::clamp(optNumber(params["timeout"]).value_or(120), 1.0, 600.0);
            s_run.started = std::chrono::steady_clock::now();

            // Faster than real time, within the range GD's physics stays stable in
            auto speed = std::clamp(optNumber(params["speed"]).value_or(1), 0.25, 4.0);
            auto scheduler = CCDirector::get()->getScheduler();
            s_run.oldTimeScale = scheduler->getTimeScale();
            scheduler->setTimeScale(static_cast<float>(speed));

            editor.ui->onPlaytest(nullptr);
            s_run.startX = editor.layer->m_player1 ? editor.layer->m_player1->getPositionX() : 0;
            s_run.active = true;
            auto optional = [](std::optional<double> value) { return value ? matjson::Value(*value) : matjson::Value(nullptr); };
            return Ok(matjson::makeObject({
                { "started", true },
                { "untilX", optional(s_run.untilX) },
                { "duration", optional(s_run.duration) },
            }));
        }

        RpcResult testPoll(matjson::Value const&) {
            checkRun();
            if (s_run.active) return Ok(matjson::makeObject({ { "running", true } }));
            if (!s_run.finished) return fail("no_test", "No test has been run.");

            auto end = toLevel(s_run.endPos);
            int inputsUsed = 0;
            for (auto const& queue : s_run.queues) inputsUsed += static_cast<int>(queue.next);
            auto result = matjson::makeObject({
                { "running", false },
                { "result", s_run.outcome },
                { "x", std::round(end.x) },
                { "y", std::round(end.y) },
                { "time", std::round(s_run.time * 100) / 100 },
                { "inputsUsed", inputsUsed },
                { "path", s_run.path },
            });
            if (s_run.untilX) {
                auto length = *s_run.untilX - s_run.startX;
                auto progress = length > 0 ? std::clamp((s_run.endPos.x - s_run.startX) / length * 100, 0.0, 100.0) : 0.0;
                result["progressPercent"] = std::round(progress);
            }
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
