#include <Geode/Geode.hpp>

#include "Bridge.hpp"
#include "net/HttpServer.hpp"

using namespace geode::prelude;

$on_mod(Loaded) {
    auto mod = Mod::get();
    if (!mod->getSettingValue<bool>("enabled")) {
        log::info("Bridge is disabled in the mod settings");
        return;
    }

    auto port = static_cast<int>(mod->getSettingValue<int64_t>("port"));
    auto error = gdbuilder::net::startServer(port, gdbuilder::handleRequest);
    if (error.empty()) {
        log::info("Bridge listening on 127.0.0.1:{}", port);
    }
    else {
        log::error("Bridge could not start: {}", error);
    }
}
