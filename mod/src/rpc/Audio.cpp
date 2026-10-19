// What the game is playing and how loud each sound comes out, so sound
// triggers can be checked without listening: proximity, volume changes,
// loops, the song a level starts.
#include "Rpc.hpp"

#include <Geode/fmod/fmod.hpp>

#include <cmath>
#include <unordered_map>

using namespace geode::prelude;

namespace gdforge::rpc {

    namespace {
        double tidy(float value) {
            return std::round(value * 1000.0) / 1000.0;
        }

        // FMOD keeps no file names for the game's sounds; the engine's own tables do.
        struct Files {
            std::unordered_map<FMOD::Sound*, std::string> sfx;
            std::unordered_map<FMOD::Sound*, std::pair<int, std::string>> music;
        };

        Files filesOf(FMODAudioEngine* engine) {
            Files files;
            for (auto const& [path, sound] : engine->m_soundPathToSound) {
                if (sound) files.sfx[sound] = std::string(path);
            }
            for (auto const& [channel, music] : engine->m_fmodMusic) {
                if (music.m_sound) files.music[music.m_sound] = { channel, std::string(music.m_filePath) };
            }
            return files;
        }

        void collect(FMOD::ChannelGroup* group, std::string const& parent, Files const& files, matjson::Value& out) {
            char name[256] = {};
            group->getName(name, sizeof(name));
            auto path = parent.empty() ? std::string(name) : parent + "/" + name;

            int channels = 0;
            group->getNumChannels(&channels);
            for (int i = 0; i < channels; ++i) {
                FMOD::Channel* channel = nullptr;
                if (group->getChannel(i, &channel) != FMOD_OK || !channel) continue;
                bool playing = false;
                if (channel->isPlaying(&playing) != FMOD_OK || !playing) continue;

                char file[512] = {};
                FMOD::Sound* sound = nullptr;
                if (channel->getCurrentSound(&sound) == FMOD_OK && sound) sound->getName(file, sizeof(file));
                std::string soundName = file;
                std::optional<int> musicChannel;
                if (auto it = files.music.find(sound); it != files.music.end()) {
                    musicChannel = it->second.first;
                    soundName = it->second.second;
                }
                else if (auto it = files.sfx.find(sound); it != files.sfx.end()) soundName = it->second;
                float volume = 0.f;
                float audibility = 0.f;
                float pitch = 1.f;
                bool paused = false;
                unsigned int position = 0;
                channel->getVolume(&volume);
                // Every volume applied to it multiplied together: its own, its groups', 3D
                channel->getAudibility(&audibility);
                channel->getPitch(&pitch);
                channel->getPaused(&paused);
                channel->getPosition(&position, FMOD_TIMEUNIT_MS);

                auto entry = matjson::makeObject({
                    { "sound", soundName },
                    { "group", path },
                    { "volume", tidy(volume) },
                    { "audible", tidy(audibility) },
                    { "pitch", tidy(pitch) },
                    { "positionMs", static_cast<int>(position) },
                });
                if (paused) entry["paused"] = true;
                // Songs play on numbered channels, which Song and Edit Song triggers address
                if (musicChannel) entry["musicChannel"] = *musicChannel;
                out.push(std::move(entry));
            }

            int groups = 0;
            group->getNumGroups(&groups);
            for (int i = 0; i < groups; ++i) {
                FMOD::ChannelGroup* child = nullptr;
                if (group->getGroup(i, &child) == FMOD_OK && child) collect(child, path, files, out);
            }
        }

        RpcResult playing(matjson::Value const&) {
            auto engine = FMODAudioEngine::get();
            FMOD::ChannelGroup* master = nullptr;
            if (!engine || !engine->m_system || engine->m_system->getMasterChannelGroup(&master) != FMOD_OK || !master) {
                return fail("internal", "The game's sound system is not running.");
            }
            auto sounds = matjson::Value::array();
            collect(master, "", filesOf(engine), sounds);
            return Ok(matjson::makeObject({
                // The player's settings, which scale everything below
                { "musicVolume", tidy(engine->m_musicVolume) },
                { "sfxVolume", tidy(engine->m_sfxVolume) },
                { "playing", std::move(sounds) },
            }));
        }
    }

    void registerAudio(RpcRegistry& registry) {
        registry["audio.playing"] = playing;
    }

}
