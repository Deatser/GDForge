#include "Rpc.hpp"

#include <algorithm>
#include <map>
#include <set>
#include <unordered_map>
#include <unordered_set>
#include <utility>

using namespace geode::prelude;

// Objects are addressed by GameObject::m_uniqueID, which the game assigns when
// an object is created and which stays stable for the editor session.
//
// Object data crosses the bridge as the game's own save-string format
// ("1,1,2,15,3,15;..."), produced by GameObject::getSaveString and consumed by
// EditorUI::pasteObjects. That keeps the mod agnostic of individual
// properties: anything the game can save, the MCP server can read and write.

namespace gdforge::rpc {

    namespace {
        using ObjectIndex = std::unordered_map<int, GameObject*>;

        ObjectIndex indexByUID(LevelEditorLayer* layer) {
            ObjectIndex index;
            index.reserve(layer->m_objects->count());
            for (auto object : CCArrayExt<GameObject*>(layer->m_objects)) {
                index[object->m_uniqueID] = object;
            }
            return index;
        }

        std::vector<int> uidsOf(CCArray* objects) {
            std::vector<int> uids;
            if (!objects) return uids;
            uids.reserve(objects->count());
            for (auto object : CCArrayExt<GameObject*>(objects)) {
                uids.push_back(object->m_uniqueID);
            }
            return uids;
        }

        // Unknown UIDs are skipped: an object the AI read a moment ago may
        // since have been deleted by the user.
        CCArray* resolve(LevelEditorLayer* layer, std::vector<int> const& uids) {
            auto index = indexByUID(layer);
            auto objects = CCArray::create();
            std::unordered_set<int> seen;
            for (auto uid : uids) {
                auto it = index.find(uid);
                if (it != index.end() && seen.insert(uid).second) objects->addObject(it->second);
            }
            return objects;
        }

        // Pasting and deleting both go through the editor's selection. This
        // puts the user's own selection back afterwards.
        class SelectionGuard {
        public:
            explicit SelectionGuard(Editor const& editor)
              : m_editor(editor), m_uids(uidsOf(editor.ui->getSelectedObjects())) {}

            void restore() {
                m_editor.ui->deselectAll();
                auto objects = resolve(m_editor.layer, m_uids);
                if (objects->count() > 0) m_editor.ui->selectObjects(objects, true);
            }

        private:
            Editor m_editor;
            std::vector<int> m_uids;
        };

        std::vector<int> paste(Editor const& editor, std::string const& data) {
            // Paste-in-place: keeps positions, records one undo step, selects the result
            return uidsOf(editor.ui->pasteObjects(data, false, false));
        }

        int deleteAll(Editor const& editor, CCArray* objects) {
            if (objects->count() == 0) return 0;
            auto before = editor.layer->m_objects->count();
            editor.ui->deselectAll();
            editor.ui->selectObjects(objects, true);
            // Same handler as the editor's trash button: one undo step for the lot
            editor.ui->onDeleteSelected(nullptr);
            return static_cast<int>(before - editor.layer->m_objects->count());
        }

        bool inGroup(GameObject* object, int group) {
            if (!object->m_groups) return false;
            auto end = object->m_groups->begin() + std::min<int>(object->m_groupCount, 10);
            return std::find(object->m_groups->begin(), end, group) != end;
        }

        RpcResult getObjects(matjson::Value const& params) {
            GEODE_UNWRAP_INTO(auto editor, requireEditor());

            auto uids = intList(params["uids"]);
            auto ids = intList(params["ids"]);
            std::unordered_set<int> uidFilter(uids.begin(), uids.end());
            std::unordered_set<int> idFilter(ids.begin(), ids.end());
            auto rect = numberList(params["rect"]);
            auto group = optInt(params["group"]);
            auto editorLayer = optInt(params["layer"]);
            auto offset = static_cast<size_t>(std::max(0, optInt(params["offset"]).value_or(0)));
            auto limit = static_cast<size_t>(std::max(0, optInt(params["limit"]).value_or(500)));

            auto source = flag(params["selected"], false)
                ? editor.ui->getSelectedObjects()
                : editor.layer->m_objects;

            std::vector<GameObject*> matches;
            for (auto object : CCArrayExt<GameObject*>(source)) {
                if (!uidFilter.empty() && !uidFilter.contains(object->m_uniqueID)) continue;
                if (!idFilter.empty() && !idFilter.contains(object->m_objectID)) continue;
                if (group && !inGroup(object, *group)) continue;
                if (editorLayer && object->m_editorLayer != *editorLayer && object->m_editorLayer2 != *editorLayer) continue;
                if (rect.size() == 4) {
                    auto pos = toLevel(object->getPosition());
                    if (pos.x < rect[0] || pos.y < rect[1] || pos.x > rect[2] || pos.y > rect[3]) continue;
                }
                matches.push_back(object);
            }

            // Left to right, the order a level is read in
            std::sort(matches.begin(), matches.end(), [](GameObject* a, GameObject* b) {
                auto pa = a->getPosition();
                auto pb = b->getPosition();
                if (pa.x != pb.x) return pa.x < pb.x;
                if (pa.y != pb.y) return pa.y < pb.y;
                return a->m_uniqueID < b->m_uniqueID;
            });

            auto objects = matjson::Value::array();
            for (auto i = offset; i < matches.size() && i < offset + limit; i++) {
                auto entry = matjson::Value::array();
                entry.push(matches[i]->m_uniqueID);
                entry.push(std::string(matches[i]->getSaveString(editor.layer)));
                objects.push(std::move(entry));
            }
            return Ok(matjson::makeObject({
                { "total", static_cast<int>(matches.size()) },
                { "objects", std::move(objects) },
            }));
        }

        // An overview of the level that is cheap to read even when it holds
        // a hundred thousand objects.
        RpcResult summarize(matjson::Value const&) {
            GEODE_UNWRAP_INTO(auto editor, requireEditor());

            std::map<int, int> countById;
            std::set<int> groups;
            std::set<int> colors;
            auto first = true;
            float minX = 0, minY = 0, maxX = 0, maxY = 0;

            for (auto object : CCArrayExt<GameObject*>(editor.layer->m_objects)) {
                countById[object->m_objectID]++;

                auto pos = toLevel(object->getPosition());
                if (std::exchange(first, false)) {
                    minX = maxX = pos.x;
                    minY = maxY = pos.y;
                }
                minX = std::min(minX, pos.x);
                minY = std::min(minY, pos.y);
                maxX = std::max(maxX, pos.x);
                maxY = std::max(maxY, pos.y);

                if (object->m_groups) {
                    for (int i = 0; i < std::min<int>(object->m_groupCount, 10); i++) {
                        groups.insert((*object->m_groups)[i]);
                    }
                }
                // Groups a trigger acts on are in use even if no object is in them yet
                if (object->m_classType == GameObjectClassType::Effect) {
                    auto effect = static_cast<EffectGameObject*>(object);
                    if (effect->m_targetGroupID > 0) groups.insert(effect->m_targetGroupID);
                    if (effect->m_centerGroupID > 0) groups.insert(effect->m_centerGroupID);
                }
                if (object->m_baseColor && object->m_baseColor->m_colorID > 0) {
                    colors.insert(object->m_baseColor->m_colorID);
                }
                if (object->m_detailColor && object->m_detailColor->m_colorID > 0) {
                    colors.insert(object->m_detailColor->m_colorID);
                }
            }

            auto counts = matjson::Value::array();
            for (auto [id, count] : countById) {
                auto entry = matjson::Value::array();
                entry.push(id);
                entry.push(count);
                counts.push(std::move(entry));
            }
            auto bounds = matjson::Value::array();
            if (!first) {
                for (auto value : { minX, minY, maxX, maxY }) bounds.push(value);
            }
            return Ok(matjson::makeObject({
                { "bounds", std::move(bounds) },
                { "countById", std::move(counts) },
                { "groups", toJson(std::vector<int>(groups.begin(), groups.end())) },
                { "colors", toJson(std::vector<int>(colors.begin(), colors.end())) },
            }));
        }

        RpcResult addObjects(matjson::Value const& params) {
            GEODE_UNWRAP_INTO(auto editor, requireEditable());
            auto data = params["data"].asString().unwrapOr("");
            if (data.empty()) return fail("bad_params", "\"data\" must be a non-empty object string");

            SelectionGuard selection(editor);
            auto created = paste(editor, data);
            if (!flag(params["select"], false)) selection.restore();
            refreshUI(editor.ui);
            return Ok(matjson::makeObject({ { "uids", toJson(created) } }));
        }

        RpcResult deleteObjects(matjson::Value const& params) {
            GEODE_UNWRAP_INTO(auto editor, requireEditable());
            auto targets = resolve(editor.layer, intList(params["uids"]));

            SelectionGuard selection(editor);
            auto deleted = deleteAll(editor, targets);
            selection.restore();
            refreshUI(editor.ui);
            return Ok(matjson::makeObject({ { "deleted", deleted } }));
        }

        // Swaps objects for new versions of themselves. This is how arbitrary
        // properties are edited: the game has no generic setter, but it can
        // always rebuild an object from its save string.
        RpcResult replaceObjects(matjson::Value const& params) {
            GEODE_UNWRAP_INTO(auto editor, requireEditable());
            auto data = params["data"].asString().unwrapOr("");
            if (data.empty()) return fail("bad_params", "\"data\" must be a non-empty object string");
            auto targets = resolve(editor.layer, intList(params["uids"]));

            SelectionGuard selection(editor);
            auto deleted = deleteAll(editor, targets);
            auto created = paste(editor, data);
            if (!flag(params["select"], false)) selection.restore();
            refreshUI(editor.ui);
            return Ok(matjson::makeObject({
                { "deleted", deleted },
                { "uids", toJson(created) },
            }));
        }

        // Moves, rotates, scales and flips objects in place with the same
        // routines the editor's own controls use, as a single undo step.
        RpcResult transformObjects(matjson::Value const& params) {
            GEODE_UNWRAP_INTO(auto editor, requireEditable());
            auto targets = resolve(editor.layer, intList(params["uids"]));
            if (targets->count() == 0) return Ok(matjson::makeObject({ { "transformed", 0 } }));

            auto ui = editor.ui;
            editor.layer->addToUndoList(
                UndoObject::createWithTransformObjects(targets, UndoCommand::Transform), false
            );

            auto pivotParam = numberList(params["pivot"]);
            auto pivot = pivotParam.size() == 2
                ? toLayer(ccp(pivotParam[0], pivotParam[1]))
                : ui->getGroupCenter(targets, false);

            if (auto move = numberList(params["move"]); move.size() == 2) {
                for (auto object : CCArrayExt<GameObject*>(targets)) {
                    ui->moveObject(object, ccp(move[0], move[1]));
                }
            }
            if (auto degrees = optNumber(params["rotate"])) {
                ui->rotateObjects(targets, static_cast<float>(*degrees), pivot);
            }
            if (auto scale = numberList(params["scale"]); scale.size() == 2) {
                // scaleObjects scales relative to the values captured here
                ui->resetObjectEditorValues(targets);
                ui->scaleObjects(
                    targets, static_cast<float>(scale[0]), static_cast<float>(scale[1]),
                    pivot, ObjectScaleType::XY, false
                );
            }
            if (flag(params["flipX"], false)) ui->flipObjectsX(targets);
            if (flag(params["flipY"], false)) ui->flipObjectsY(targets);

            refreshUI(ui);
            return Ok(matjson::makeObject({ { "transformed", static_cast<int>(targets->count()) } }));
        }

        RpcResult setSelection(matjson::Value const& params) {
            GEODE_UNWRAP_INTO(auto editor, requireEditable());
            auto targets = resolve(editor.layer, intList(params["uids"]));
            editor.ui->deselectAll();
            if (targets->count() > 0) editor.ui->selectObjects(targets, true);
            refreshUI(editor.ui);
            return Ok(matjson::makeObject({ { "selected", static_cast<int>(targets->count()) } }));
        }
    }

    void registerObjects(RpcRegistry& registry) {
        registry["objects.get"] = getObjects;
        registry["objects.summary"] = summarize;
        registry["objects.add"] = addObjects;
        registry["objects.delete"] = deleteObjects;
        registry["objects.replace"] = replaceObjects;
        registry["objects.transform"] = transformObjects;
        registry["selection.set"] = setSelection;
    }

}
