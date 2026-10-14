#include "Rpc.hpp"

#include <algorithm>

using namespace geode::prelude;

namespace gdbuilder::rpc {

    namespace {
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

        // Moves the view so the user can watch what is being built.
        RpcResult camera(matjson::Value const& params) {
            GEODE_UNWRAP_INTO(auto editor, requireEditor());
            auto objectLayer = editor.layer->m_objectLayer;

            if (auto zoom = optNumber(params["zoom"])) {
                editor.ui->updateZoom(std::clamp(static_cast<float>(*zoom), .1f, 4.f));
            }
            auto x = optNumber(params["x"]);
            auto y = optNumber(params["y"]);
            if (x || y) {
                auto winSize = CCDirector::get()->getWinSize();
                auto zoom = objectLayer->getScale();
                auto offset = objectLayer->getPosition();
                if (x) offset.x = winSize.width * .5f - static_cast<float>(*x) * zoom;
                if (y) offset.y = winSize.height * .5f - (static_cast<float>(*y) + GROUND_OFFSET) * zoom;
                objectLayer->setPosition(offset);
                editor.ui->constrainGameLayerPosition(-100.f, -100.f);
                editor.ui->updateSlider();
            }
            return Ok(editorInfo(editor)["camera"]);
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
