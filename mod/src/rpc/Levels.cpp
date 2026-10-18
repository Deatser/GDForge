#include "Rpc.hpp"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <system_error>

using namespace geode::prelude;

namespace gdforge::rpc {

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

        // The open level as the game saves it: settings header, then every object
        RpcResult levelString(matjson::Value const&) {
            GEODE_UNWRAP_INTO(auto editor, requireEditor());
            return Ok(matjson::makeObject({ { "levelString", std::string(editor.layer->getLevelString()) } }));
        }

        // Saves the open level like the Save button of the editor's pause menu, then
        // writes the created levels to disk so the work survives a crash. Adapted from
        // AI Level Connector by Oliver (MIT, see THIRD_PARTY.md).
        RpcResult save(matjson::Value const&) {
            GEODE_UNWRAP_INTO(auto editor, requireEditable());
            auto pause = EditorPauseLayer::create(editor.layer);
            if (!pause) return fail("internal", "The game could not create its save menu.");
            pause->saveLevel();
            LocalLevelManager::get()->save();
            return Ok(matjson::makeObject({ { "saved", std::string(editor.layer->m_level->m_levelName) } }));
        }

        // Sets the open level's custom song (a Newgrounds ID). Takes effect in the level once it is saved.
        RpcResult song(matjson::Value const& params) {
            GEODE_UNWRAP_INTO(auto editor, requireEditable());
            auto id = optInt(params["songId"]);
            if (!id || *id < 0) {
                return fail("bad_params", "Pass \"songId\": a Newgrounds song ID, or 0 to clear the custom song");
            }
            editor.layer->m_level->m_songID = *id;
            return Ok(matjson::makeObject({ { "songId", *id } }));
        }

        // Audio files the game has, downloaded songs first. Songs downloaded from
        // Newgrounds are saved as <song ID>.mp3, so the ID is read from the name.
        RpcResult localSongs(matjson::Value const& params) {
            auto needle = geode::utils::string::toLower(params["query"].asString().unwrapOr(""));
            auto limit = static_cast<size_t>(std::clamp(optInt(params["limit"]).value_or(20), 1, 100));
            auto songs = matjson::Value::array();
            for (auto const& root : { geode::dirs::getSaveDir(), geode::dirs::getGameDir() / "Resources" }) {
                std::error_code error;
                for (auto it = std::filesystem::recursive_directory_iterator(
                         root, std::filesystem::directory_options::skip_permission_denied, error);
                     !error && it != std::filesystem::recursive_directory_iterator() && songs.size() < limit;
                     it.increment(error)) {
                    auto const& path = it->path();
                    std::string name, stem, extension;
                    // A name that does not convert to the narrow charset is not a song we can report
                    try {
                        name = path.filename().string();
                        stem = path.stem().string();
                        extension = geode::utils::string::toLower(path.extension().string());
                    }
                    catch (std::exception const&) {
                        continue;
                    }
                    if (extension != ".mp3" && extension != ".ogg" && extension != ".wav") continue;
                    if (geode::utils::string::toLower(name).find(needle) == std::string::npos) continue;
                    auto numeric = !stem.empty() && stem.size() <= 9
                        && std::all_of(stem.begin(), stem.end(), [](unsigned char c) { return std::isdigit(c); });
                    songs.push(matjson::makeObject({
                        { "fileName", name },
                        { "songId", numeric ? matjson::Value(std::stoi(stem)) : matjson::Value(nullptr) },
                    }));
                }
            }
            return Ok(matjson::makeObject({ { "songs", std::move(songs) } }));
        }
    }

    void registerLevels(RpcRegistry& registry) {
        registry["levels.list"] = list;
        registry["levels.open"] = open;
        registry["level.string"] = levelString;
        registry["level.save"] = save;
        registry["level.song"] = song;
        registry["songs.local"] = localSongs;
    }

}
