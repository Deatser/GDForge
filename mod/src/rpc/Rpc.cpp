#include "Rpc.hpp"

#include <cmath>

using namespace geode::prelude;

namespace gdbuilder::rpc {

    geode::Result<Editor, RpcError> requireEditor() {
        auto layer = LevelEditorLayer::get();
        if (!layer || !layer->m_editorUI) {
            return fail("no_editor", "No level is open in the editor. Open one in Geometry Dash, or use levels.open.");
        }
        // The editor exists as soon as its scene is built, a moment before the game has switched to it
        if (typeinfo_cast<CCTransitionScene*>(CCDirector::get()->getRunningScene())) {
            return fail("busy", "The game is switching screens. Try again in a moment.");
        }
        return Ok(Editor { layer, layer->m_editorUI });
    }

    geode::Result<Editor, RpcError> requireEditable() {
        GEODE_UNWRAP_INTO(auto editor, requireEditor());
        if (editor.layer->m_playbackMode != PlaybackMode::Not) {
            return fail("playtesting", "The level is being playtested. Stop the playtest before changing objects.");
        }
        auto scene = CCDirector::get()->getRunningScene();
        if (scene && scene->getChildByType<FLAlertLayer>(0)) {
            return fail("popup_open", "A popup is open in the editor. Close it before changing objects.");
        }
        return Ok(editor);
    }

    matjson::Value editorInfo(Editor const& editor) {
        auto layer = editor.layer;
        auto objectLayer = layer->m_objectLayer;
        auto winSize = CCDirector::get()->getWinSize();
        auto zoom = objectLayer->getScale();
        auto offset = objectLayer->getPosition();

        auto level = matjson::makeObject({
            { "name", std::string(layer->m_level->m_levelName) },
            { "objectCount", static_cast<int>(layer->m_objects->count()) },
            { "lastObjectX", layer->getLastObjectX() },
        });
        // The level point at the centre of the screen, and how much of the level is visible around it
        auto centre = toLevel(ccp(
            (winSize.width * .5f - offset.x) / zoom,
            (winSize.height * .5f - offset.y) / zoom
        ));
        // Three decimals is plenty and keeps 0.8 from reading as 0.800000011920929
        auto tidy = [](float value) { return std::round(value * 1000.0) / 1000.0; };
        auto camera = matjson::makeObject({
            { "x", tidy(centre.x) },
            { "y", tidy(centre.y) },
            { "zoom", tidy(zoom) },
            { "viewWidth", tidy(winSize.width / zoom) },
            { "viewHeight", tidy(winSize.height / zoom) },
        });
        return matjson::makeObject({
            { "level", std::move(level) },
            { "camera", std::move(camera) },
            { "editorLayer", static_cast<int>(layer->m_currentLayer) },
            { "selectedCount", static_cast<int>(editor.ui->getSelectedObjects()->count()) },
            { "undoCount", static_cast<int>(layer->m_undoObjects->count()) },
            { "redoCount", static_cast<int>(layer->m_redoObjects->count()) },
            { "playtesting", layer->m_playbackMode != PlaybackMode::Not },
        });
    }

    void refreshUI(EditorUI* ui) {
        ui->updateButtons();
        ui->updateObjectInfoLabel();
    }

    std::optional<double> optNumber(matjson::Value const& value) {
        if (!value.isNumber()) return std::nullopt;
        return value.asDouble().unwrapOr(0.0);
    }

    std::optional<int> optInt(matjson::Value const& value) {
        if (auto number = optNumber(value)) return static_cast<int>(*number);
        return std::nullopt;
    }

    bool flag(matjson::Value const& value, bool fallback) {
        return value.asBool().unwrapOr(fallback);
    }

    std::vector<int> intList(matjson::Value const& value) {
        std::vector<int> out;
        if (!value.isArray()) return out;
        for (auto const& item : value) {
            if (auto number = optInt(item)) out.push_back(*number);
        }
        return out;
    }

    std::vector<double> numberList(matjson::Value const& value) {
        std::vector<double> out;
        if (!value.isArray()) return out;
        for (auto const& item : value) {
            if (auto number = optNumber(item)) out.push_back(*number);
        }
        return out;
    }

    matjson::Value toJson(std::vector<int> const& values) {
        auto out = matjson::Value::array();
        for (auto value : values) out.push(value);
        return out;
    }

}
