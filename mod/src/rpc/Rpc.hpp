#pragma once

#include "../Bridge.hpp"

#include <optional>
#include <vector>

namespace gdforge::rpc {

    void registerStatus(RpcRegistry& registry);
    void registerEditor(RpcRegistry& registry);
    void registerObjects(RpcRegistry& registry);
    void registerLevels(RpcRegistry& registry);
    void registerCatalog(RpcRegistry& registry);
    void registerPlaytest(RpcRegistry& registry);
    void registerScreenshot(RpcRegistry& registry);
    void registerUi(RpcRegistry& registry);
    void registerAudio(RpcRegistry& registry);

    struct Editor {
        LevelEditorLayer* layer;
        EditorUI* ui;
    };

    // The editor draws the level this far above the origin of its object
    // layer: an object saved at y = 15 sits at y = 105 on screen. The bridge
    // speaks saved (level) coordinates throughout, so anything read from or
    // written to node positions is converted with the two helpers below.
    constexpr float GROUND_OFFSET = 90.f;

    inline cocos2d::CCPoint toLevel(cocos2d::CCPoint layerPoint) {
        return { layerPoint.x, layerPoint.y - GROUND_OFFSET };
    }

    inline cocos2d::CCPoint toLayer(cocos2d::CCPoint levelPoint) {
        return { levelPoint.x, levelPoint.y + GROUND_OFFSET };
    }

    // The level editor, if one is open.
    geode::Result<Editor, RpcError> requireEditor();
    // The level editor in a state where the level can be changed: not
    // playtesting, and no popup open that may hold pointers to objects.
    geode::Result<Editor, RpcError> requireEditable();

    matjson::Value editorInfo(Editor const& editor);
    // Refreshes the editor's buttons and info label after objects or the selection changed.
    void refreshUI(EditorUI* ui);

    // Lenient readers for request parameters; absent or mistyped values read as empty.
    std::optional<double> optNumber(matjson::Value const& value);
    std::optional<int> optInt(matjson::Value const& value);
    bool flag(matjson::Value const& value, bool fallback);
    std::vector<int> intList(matjson::Value const& value);
    std::vector<double> numberList(matjson::Value const& value);

    matjson::Value toJson(std::vector<int> const& values);

}
