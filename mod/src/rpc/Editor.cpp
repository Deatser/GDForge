#include "Rpc.hpp"

#include <Geode/modify/GJBaseGameLayer.hpp>
#include <Geode/modify/LevelEditorLayer.hpp>

#include <algorithm>
#include <optional>

using namespace geode::prelude;

namespace gdforge::rpc {

    namespace {
        // The editor's own "Hide Invisible" option (its pause menu), a game variable
        constexpr char const* HIDE_INVISIBLE = "0121";

        // Level point the view stays centred on during a playtest instead of following the player
        std::optional<CCPoint> s_cameraPin;

        // Puts the playtest camera on the pinned point, after the game has aimed it at the player.
        void applyCameraPin(GJBaseGameLayer* layer) {
            if (!s_cameraPin || layer != static_cast<GJBaseGameLayer*>(LevelEditorLayer::get())) return;
            // Back in the editor the view is the user's again
            if (layer->m_playbackMode == PlaybackMode::Not) {
                s_cameraPin.reset();
                return;
            }
            auto objectLayer = layer->m_objectLayer;
            auto zoom = objectLayer->getScale();
            auto winSize = CCDirector::get()->getWinSize();
            auto centre = toLayer(*s_cameraPin);
            // The camera position is the bottom left corner of the view
            auto corner = ccp(centre.x - winSize.width * .5f / zoom, centre.y - winSize.height * .5f / zoom);
            layer->m_gameState.m_cameraPosition = corner;
            objectLayer->setPosition(ccp(-corner.x * zoom, -corner.y * zoom));
        }

        RpcResult status(matjson::Value const&) {
            auto editor = requireEditor();
            return Ok(matjson::makeObject({
                { "mod", Mod::get()->getVersion().toNonVString() },
                { "geode", Loader::get()->getVersion().toNonVString() },
                { "gd", Loader::get()->getGameVersion() },
                { "platform", GEODE_PLATFORM_SHORT_IDENTIFIER },
                { "editor", editor ? editorInfo(editor.unwrap()) : matjson::Value(nullptr) },
            }));
        }

        RpcResult info(matjson::Value const&) {
            GEODE_UNWRAP_INTO(auto editor, requireEditor());
            return Ok(editorInfo(editor));
        }

        RpcResult undoRedo(bool undo) {
            GEODE_UNWRAP_INTO(auto editor, requireEditable());
            auto history = undo ? editor.layer->m_undoObjects : editor.layer->m_redoObjects;
            auto performed = history->count() > 0;
            if (performed) {
                if (undo) editor.ui->undoLastAction(nullptr);
                else editor.ui->redoLastAction(nullptr);
            }
            return Ok(matjson::makeObject({
                { "performed", performed },
                { "undoCount", static_cast<int>(editor.layer->m_undoObjects->count()) },
                { "redoCount", static_cast<int>(editor.layer->m_redoObjects->count()) },
            }));
        }

        // Moves the view so the user can watch what is being built. During a
        // playtest the view is pinned to the point until "follow" or the next playtest.
        RpcResult camera(matjson::Value const& params) {
            GEODE_UNWRAP_INTO(auto editor, requireEditor());
            auto objectLayer = editor.layer->m_objectLayer;
            auto playing = editor.layer->m_playbackMode != PlaybackMode::Not;

            if (params["hideInvisible"].isBool()) {
                GameManager::get()->setGameVariable(HIDE_INVISIBLE, params["hideInvisible"].asBool().unwrap());
            }
            if (auto zoom = optNumber(params["zoom"])) {
                editor.ui->updateZoom(std::clamp(static_cast<float>(*zoom), .1f, 4.f));
            }
            auto x = optNumber(params["x"]);
            auto y = optNumber(params["y"]);
            if (playing) {
                if (flag(params["follow"], false)) {
                    s_cameraPin.reset();
                }
                else if (x || y) {
                    auto current = editorInfo(editor)["camera"];
                    s_cameraPin = ccp(
                        static_cast<float>(x.value_or(current["x"].asDouble().unwrapOr(0.0))),
                        static_cast<float>(y.value_or(current["y"].asDouble().unwrapOr(0.0)))
                    );
                    applyCameraPin(editor.layer);
                }
            }
            else if (x || y) {
                auto winSize = CCDirector::get()->getWinSize();
                auto zoom = objectLayer->getScale();
                auto offset = objectLayer->getPosition();
                if (x) offset.x = winSize.width * .5f - static_cast<float>(*x) * zoom;
                if (y) offset.y = winSize.height * .5f - (static_cast<float>(*y) + GROUND_OFFSET) * zoom;
                objectLayer->setPosition(offset);
                editor.ui->constrainGameLayerPosition(-100.f, -100.f);
                editor.ui->updateSlider();
            }
            auto result = editorInfo(editor)["camera"];
            result["hideInvisible"] = GameManager::get()->getGameVariable(HIDE_INVISIBLE);
            if (playing) result["pinned"] = s_cameraPin.has_value();
            return Ok(result);
        }
    }

    void registerStatus(RpcRegistry& registry) {
        registry["status"] = status;
    }

    void registerEditor(RpcRegistry& registry) {
        registry["editor.info"] = info;
        registry["editor.undo"] = [](matjson::Value const&) { return undoRedo(true); };
        registry["editor.redo"] = [](matjson::Value const&) { return undoRedo(false); };
        registry["editor.camera"] = camera;
    }

}

class $modify(GJBaseGameLayer) {
    void updateCamera(float dt) {
        GJBaseGameLayer::updateCamera(dt);
        gdforge::rpc::applyCameraPin(this);
    }
};

class $modify(LevelEditorLayer) {
    // Every playtest starts out following the player
    void onPlaytest() {
        gdforge::rpc::s_cameraPin.reset();
        LevelEditorLayer::onPlaytest();
    }
};
