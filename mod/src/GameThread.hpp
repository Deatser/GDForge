#pragma once

#include <functional>

namespace gdbuilder {

    // Runs func on the thread that runs the game loop, the only thread that
    // may touch cocos and game state. (On macOS that is a display-link thread,
    // not the process main thread.)
    //
    // Unlike geode::queueInMainThread this keeps working while the game is
    // paused in the background, which on macOS is whenever another app such as
    // the AI client has focus. If a level is open in the editor the game is
    // also resumed, so the user can watch the level change.
    void runOnGameThread(std::function<void()> func);

}
