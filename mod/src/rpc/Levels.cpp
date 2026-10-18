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
            // Leaving the loading screen early stops the game loading its textures for the whole session
            if (auto scene = director->getRunningScene(); scene && scene->getChildByType<LoadingLayer>(0)) {
                return fail("busy", "The game is still loading. Try again once the main menu shows.");
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

        // Sets the open level's song: a custom one by Newgrounds ID, or one of the
        // game's own ("track", the Normal tab). Takes effect in the level once it is saved.
        RpcResult song(matjson::Value const& params) {
            GEODE_UNWRAP_INTO(auto editor, requireEditable());
            auto level = editor.layer->m_level;
            if (auto track = optInt(params["track"])) {
                auto title = *track >= 0 ? std::string(LevelTools::getAudioTitle(*track)) : "";
                if (title.empty() || title == "Unknown") {
                    return fail("bad_params", "The game has no song with that track number");
                }
                level->m_songID = 0;
                level->m_audioTrack = *track;
                return Ok(matjson::makeObject({ { "track", *track }, { "title", title } }));
            }
            auto id = optInt(params["songId"]);
            if (!id || *id < 0) {
                return fail("bad_params", "Pass \"songId\": a Newgrounds song ID, or 0 to clear the custom song");
            }
            level->m_songID = *id;
            return Ok(matjson::makeObject({ { "songId", *id } }));
        }

        // Legacy Options (the gear inside Options): switches for fixes of old game bugs
        std::pair<char const*, bool LevelSettingsObject::*> const LEGACY_OPTIONS[] = {
            { "allowMultiRotation", &LevelSettingsObject::m_allowMultiRotation },
            { "enablePlayerSqueeze", &LevelSettingsObject::m_enablePlayerSqueeze },
            { "fixGravityBug", &LevelSettingsObject::m_fixGravityBug },
            { "fixNegativeScale", &LevelSettingsObject::m_fixNegativeScale },
            { "fixRobotJump", &LevelSettingsObject::m_fixRobotJump },
            { "dynamicLevelHeight", &LevelSettingsObject::m_dynamicLevelHeight },
            { "sortGroups", &LevelSettingsObject::m_sortGroups },
            { "fixRadiusCollision", &LevelSettingsObject::m_fixRadiusCollision },
            { "enable22Changes", &LevelSettingsObject::m_enable22Changes },
            { "allowStaticRotate", &LevelSettingsObject::m_allowStaticRotate },
            { "reverseSync", &LevelSettingsObject::m_reverseSync },
            { "decreaseBoostSlide", &LevelSettingsObject::m_decreaseBoostSlide },
            { "enableImpulseFix", &LevelSettingsObject::m_enableImpulseFix },
        };

        // The level settings of the gear button: start speed and mode, game
        // type, options, art, font and the song's offset and fades. Colour
        // channels are in the "kS38" part of saveString, as the game saves them.
        matjson::Value settingsJson(LevelSettingsObject* settings) {
            auto legacy = matjson::Value::object();
            for (auto const& [key, member] : LEGACY_OPTIONS) legacy[key] = settings->*member;
            return matjson::makeObject({
                { "speed", static_cast<int>(settings->m_startSpeed) },
                { "mode", settings->m_startMode },
                { "platformer", settings->m_platformerMode },
                { "mini", settings->m_startMini },
                { "dual", settings->m_startDual },
                { "twoPlayer", settings->m_twoPlayerMode },
                { "mirror", settings->m_mirrorMode },
                { "flipGravity", settings->m_isFlipped },
                { "rotateGameplay", settings->m_rotateGameplay },
                { "reverseGameplay", settings->m_reverseGameplay },
                { "noTimePenalty", settings->m_noTimePenalty },
                { "spawnGroup", settings->m_spawnGroup },
                { "background", settings->m_backgroundIndex },
                { "ground", settings->m_groundIndex },
                { "middleground", settings->m_middleGroundIndex },
                { "font", settings->m_fontIndex },
                { "songOffset", settings->m_songOffset },
                { "fadeIn", settings->m_fadeIn },
                { "fadeOut", settings->m_fadeOut },
                { "dontReset", settings->m_dontReset },
                { "legacy", std::move(legacy) },
                { "saveString", std::string(settings->getSaveString()) },
            });
        }

        RpcResult getSettings(matjson::Value const&) {
            GEODE_UNWRAP_INTO(auto editor, requireEditor());
            return Ok(settingsJson(editor.layer->m_levelSettings));
        }

        // Changes the given level settings and start colours, then lets the
        // editor apply them the way it does when its settings window closes
        // (MultiplayerEdit by xXoanon applies synced settings the same way).
        RpcResult setSettings(matjson::Value const& params) {
            GEODE_UNWRAP_INTO(auto editor, requireEditable());
            auto settings = editor.layer->m_levelSettings;
            auto effects = settings->m_effectManager;

            // Check everything first, so a bad value changes nothing. Out of range
            // art or font numbers would make the game load textures that do not exist.
            struct Range { char const* key; int min; int max; };
            for (auto const& [key, min, max] : {
                     Range { "speed", 0, 4 }, Range { "mode", 0, 7 }, Range { "spawnGroup", 0, 9999 },
                     Range { "background", 0, 59 }, Range { "ground", 0, 22 }, Range { "middleground", 0, 3 },
                     Range { "font", 0, 59 },
                 }) {
                if (params[key].isNull()) continue;
                auto value = optInt(params[key]);
                if (!value || *value < min || *value > max) {
                    return fail("bad_params", fmt::format("\"{}\" must be a whole number from {} to {}", key, min, max));
                }
            }
            std::vector<std::pair<ColorAction*, matjson::Value>> colors;
            if (params["colors"].isArray()) {
                for (auto const& color : params["colors"]) {
                    auto channel = optInt(color["channel"]);
                    if (!channel || *channel < 1 || *channel > 1101) {
                        return fail("bad_params", "Each colour needs \"channel\": a colour channel ID");
                    }
                    auto action = effects->getColorAction(*channel);
                    if (!action) return fail("bad_params", fmt::format("Colour channel {} cannot be set", *channel));
                    colors.emplace_back(action, color);
                }
            }

            auto setInt = [&](char const* key, int& field) {
                if (auto value = optInt(params[key])) field = *value;
            };
            auto setBool = [&](char const* key, bool& field) {
                if (params[key].isBool()) field = params[key].asBool().unwrap();
            };
            if (auto speed = optInt(params["speed"])) settings->m_startSpeed = static_cast<Speed>(*speed);
            setInt("mode", settings->m_startMode);
            setBool("platformer", settings->m_platformerMode);
            setBool("mini", settings->m_startMini);
            setBool("dual", settings->m_startDual);
            setBool("twoPlayer", settings->m_twoPlayerMode);
            setBool("mirror", settings->m_mirrorMode);
            setBool("flipGravity", settings->m_isFlipped);
            setBool("rotateGameplay", settings->m_rotateGameplay);
            setBool("reverseGameplay", settings->m_reverseGameplay);
            setBool("noTimePenalty", settings->m_noTimePenalty);
            setInt("spawnGroup", settings->m_spawnGroup);
            setInt("background", settings->m_backgroundIndex);
            setInt("ground", settings->m_groundIndex);
            setInt("middleground", settings->m_middleGroundIndex);
            setInt("font", settings->m_fontIndex);
            if (auto offset = optNumber(params["songOffset"])) settings->m_songOffset = static_cast<float>(*offset);
            setBool("fadeIn", settings->m_fadeIn);
            setBool("fadeOut", settings->m_fadeOut);
            setBool("dontReset", settings->m_dontReset);
            if (auto const& legacy = params["legacy"]; legacy.isObject()) {
                for (auto const& [key, member] : LEGACY_OPTIONS) {
                    if (legacy[key].isBool()) settings->*member = legacy[key].asBool().unwrap();
                }
            }

            for (auto const& entry : colors) {
                auto action = entry.first;
                auto const& color = entry.second;
                auto component = [&](char const* key, GLubyte current) {
                    auto value = optInt(color[key]);
                    return value ? static_cast<GLubyte>(std::clamp(*value, 0, 255)) : current;
                };
                ccColor3B rgb = {
                    component("r", action->m_fromColor.r),
                    component("g", action->m_fromColor.g),
                    component("b", action->m_fromColor.b),
                };
                action->m_color = action->m_fromColor = action->m_toColor = rgb;
                if (auto opacity = optNumber(color["opacity"])) {
                    auto value = std::clamp(static_cast<float>(*opacity), 0.f, 1.f);
                    action->m_currentOpacity = action->m_fromOpacity = action->m_toOpacity = value;
                }
                if (color["blending"].isBool()) action->m_blending = color["blending"].asBool().unwrap();
                if (auto player = optInt(color["playerColor"])) action->m_playerColor = *player;
                if (auto copy = optInt(color["copyColor"])) action->m_copyID = *copy;
                if (color["copyOpacity"].isBool()) action->m_copyOpacity = color["copyOpacity"].asBool().unwrap();
                auto const& hsv = color["hsv"];
                if (hsv.isObject()) {
                    action->m_copyHSV = cchsv(
                        static_cast<float>(optNumber(hsv["h"]).value_or(0.0)),
                        static_cast<float>(optNumber(hsv["s"]).value_or(1.0)),
                        static_cast<float>(optNumber(hsv["v"]).value_or(1.0)),
                        flag(hsv["absoluteSaturation"], false),
                        flag(hsv["absoluteBrightness"], false)
                    );
                }
                effects->colorActionChanged(action);
                if (action->m_colorSprite) effects->updateColorAction(action);
            }

            editor.layer->m_updateColorSprites = true;
            editor.layer->updateOptions();
            editor.layer->levelSettingsUpdated();
            return Ok(settingsJson(settings));
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
        registry["level.settings"] = getSettings;
        registry["level.settings.set"] = setSettings;
        registry["songs.local"] = localSongs;
    }

}
