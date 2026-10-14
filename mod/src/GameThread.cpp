#include "GameThread.hpp"

#include <Geode/Geode.hpp>
#include <Geode/modify/AppDelegate.hpp>
#include <Geode/modify/CCDisplayLinkDirector.hpp>

#include <atomic>
#include <mutex>
#include <utility>
#include <vector>

using namespace geode::prelude;

namespace gdbuilder {

    namespace {
        std::mutex s_mutex;
        std::vector<std::function<void()>> s_queue;
        // Lets the per-frame check skip the lock when there is nothing to do
        std::atomic<bool> s_hasWork = false;
        // The game has been told it is in the background and has paused itself
        std::atomic<bool> s_backgrounded = false;

        // Game thread only. Undoes what going to the background did to the
        // director, without resuming sound.
        void resumeLoop(CCDisplayLinkDirector* director) {
            director->startAnimation();
            director->resume();
        }

        // Game thread only, once per display-link tick.
        void drain(CCDisplayLinkDirector* director) {
            if (!s_hasWork.exchange(false)) return;

            std::vector<std::function<void()>> calls;
            {
                std::lock_guard lock(s_mutex);
                calls.swap(s_queue);
            }
            for (auto& call : calls) call();

            // Keep rendering in the background while a level is being built,
            // so the user sees objects appear without switching to the game
            if (s_backgrounded && LevelEditorLayer::get()) resumeLoop(director);
        }
    }

    void runOnGameThread(std::function<void()> func) {
        std::lock_guard lock(s_mutex);
        s_queue.push_back(std::move(func));
        s_hasWork = true;
    }

}

// mainLoop is called on every display-link tick, even while the director is
// paused or stopped and the cocos scheduler (which geode::queueInMainThread
// relies on) is not being updated.
class $modify(CCDisplayLinkDirector) {
    void mainLoop() {
        gdbuilder::drain(this);
        CCDisplayLinkDirector::mainLoop();
    }
};

class $modify(AppDelegate) {
    void applicationDidEnterBackground() {
        AppDelegate::applicationDidEnterBackground();
        gdbuilder::s_backgrounded = true;
    }

    void applicationWillEnterForeground() {
        gdbuilder::s_backgrounded = false;
        AppDelegate::applicationWillEnterForeground();
    }
};
