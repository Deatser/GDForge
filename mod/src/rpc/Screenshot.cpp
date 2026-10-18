// A picture of what the game shows. The scene is rendered into a texture
// rather than copied from the window, so it also works while the window is
// covered or in the background. The pixels go to a file as raw RGBA for the
// MCP server to encode; a JSON reply would be far too large for them.
#include "Rpc.hpp"

#include <fstream>

using namespace geode::prelude;

namespace gdforge::rpc {

    namespace {
        RpcResult screenshot(matjson::Value const&) {
            auto director = CCDirector::get();
            auto scene = director->getRunningScene();
            if (!scene) return fail("busy", "Nothing is on screen yet. Try again in a moment.");

            auto size = director->getWinSize();
            auto texture = CCRenderTexture::create(
                static_cast<int>(size.width), static_cast<int>(size.height), kCCTexture2DPixelFormat_RGBA8888
            );
            if (!texture) return fail("internal", "Could not create a texture to render into.");
            texture->begin();
            scene->visit();
            texture->end();

            auto image = texture->newCCImage(true);
            if (!image) return fail("internal", "Could not read the rendered picture.");
            int width = image->getWidth();
            int height = image->getHeight();
            auto path = Mod::get()->getSaveDir() / "screenshot.rgba";
            std::ofstream file(path, std::ios::binary | std::ios::trunc);
            file.write(reinterpret_cast<char const*>(image->getData()), static_cast<std::streamsize>(width) * height * 4);
            image->release();
            if (!file) return fail("internal", "Could not write the screenshot file.");

            return Ok(matjson::makeObject({
                { "path", path.string() },
                { "width", width },
                { "height", height },
            }));
        }
    }

    void registerScreenshot(RpcRegistry& registry) {
        registry["screenshot"] = screenshot;
    }

}
