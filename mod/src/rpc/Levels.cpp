#include "Rpc.hpp"

using namespace geode::prelude;

namespace gdbuilder::rpc {

    namespace {
        CCArray* localLevels() {
            return LocalLevelManager::get()->m_localLevels;
        }

        RpcResult list(matjson::Value const&) {
            auto levels = matjson::Value::array();
            int index = 0;
            for (auto level : CCArrayExt<GJGameLevel*>(localLevels())) {
                levels.push(matjson::makeObject({
                    { "index", index++ },
                    { "name", std::string(level->m_levelName) },
                    { "objectCount", level->m_objectCount.value() },
                }));
            }
            return Ok(matjson::makeObject({ { "levels", std::move(levels) } }));
        }

        // Opens one of the user's created levels in the editor, the way the
        // Edit button on the level page does. "create" makes a new level first;
        // "scratch" opens a throwaway level instead.
        RpcResult open(matjson::Value const& params) {
            if (LevelEditorLayer::get()) {
                return fail("editor_open", "A level is already open in the editor. Exit it first.");
            }
            if (GameManager::get()->m_playLayer) {
                return fail("in_level", "A level is being played. Exit it first.");
            }
            auto director = CCDirector::get();
            if (typeinfo_cast<CCTransitionScene*>(director->getRunningScene())) {
                return fail("busy", "The game is switching screens. Try again in a moment.");
            }

            GJGameLevel* level = nullptr;
            if (flag(params["scratch"], false)) {
                // Lives only in memory: never added to the user's created levels or their save file
                level = GJGameLevel::create();
                level->m_levelName = "Scratch";
                level->m_levelType = GJLevelType::Editor;
            }
            else if (params["create"].isString()) {
                level = GameLevelManager::get()->createNewLevel();
                auto name = params["create"].asString().unwrapOr("");
                if (!name.empty()) level->m_levelName = name;
            }
            else if (auto index = optInt(params["index"])) {
                auto levels = localLevels();
                if (*index < 0 || *index >= static_cast<int>(levels->count())) {
                    return fail("bad_params", "No created level at that index");
                }
                level = static_cast<GJGameLevel*>(levels->objectAtIndex(*index));
            }
            else {
                return fail("bad_params", "Pass \"index\" to open a level, \"create\" to make a new one, or \"scratch\" for a temporary one");
            }

            FMODAudioEngine::sharedEngine()->stopAllMusic(true);
            director->replaceScene(CCTransitionFade::create(.5f, LevelEditorLayer::scene(level, false)));
            return Ok(matjson::makeObject({ { "name", std::string(level->m_levelName) } }));
        }
    }

    void registerLevels(RpcRegistry& registry) {
        registry["levels.list"] = list;
        registry["levels.open"] = open;
    }

}
