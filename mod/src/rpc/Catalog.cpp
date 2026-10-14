#include "Rpc.hpp"

#include <typeinfo>
#include <unordered_map>

using namespace geode::prelude;

namespace gdbuilder::rpc {

    namespace {
        // Highest object ID to probe. IDs are sparse; 2.2081 tops out below 5000.
        constexpr int MAX_OBJECT_ID = 6000;

        // Dumps every object the game knows: its sprite frame, the build tab it
        // lives in, and the type/size a freshly created instance reports. The
        // MCP server ships a snapshot of this as its searchable object catalog.
        RpcResult dump(matjson::Value const& params) {
            // Which create tab each object's button is in, when the editor is open
            std::unordered_map<int, int> tabs;
            if (auto editor = requireEditor()) {
                for (auto bar : CCArrayExt<EditButtonBar*>(editor.unwrap().ui->m_createButtonBars)) {
                    for (auto node : CCArrayExt<CCNode*>(bar->m_buttonArray)) {
                        auto item = typeinfo_cast<CreateMenuItem*>(node);
                        if (item && item->m_objectID > 0) tabs.try_emplace(item->m_objectID, bar->m_tabIndex);
                    }
                }
            }

            auto details = flag(params["details"], true);
            auto toolbox = ObjectToolbox::sharedState();
            auto objects = matjson::Value::array();
            for (int id = 1; id <= MAX_OBJECT_ID; id++) {
                auto frame = toolbox->intKeyToFrame(id);
                if (!frame || !*frame) continue;

                auto entry = matjson::makeObject({ { "id", id }, { "frame", std::string(frame) } });
                if (auto tab = tabs.find(id); tab != tabs.end()) entry.set("tab", tab->second);
                if (details) {
                    if (auto object = GameObject::createWithKey(id)) {
                        // Type and layering are only filled in by the setup pass
                        object->customSetup();
                        auto size = object->getContentSize();
                        entry.set("type", static_cast<int>(object->m_objectType));
                        // Mangled name of the concrete class, which decides the properties the object saves
                        entry.set("class", std::string(typeid(*object).name()));
                        entry.set("w", size.width);
                        entry.set("h", size.height);
                        entry.set("zLayer", static_cast<int>(object->m_defaultZLayer));
                        entry.set("zOrder", object->m_defaultZOrder);
                        if (object->m_isTrigger) entry.set("trigger", true);
                    }
                }
                objects.push(std::move(entry));
            }
            return Ok(matjson::makeObject({ { "objects", std::move(objects) } }));
        }
    }

    void registerCatalog(RpcRegistry& registry) {
        registry["catalog.dump"] = dump;
    }

}
