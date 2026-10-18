#pragma once

#include <Geode/Geode.hpp>

#include "net/HttpServer.hpp"

#include <functional>
#include <string>
#include <unordered_map>

namespace gdforge {

    struct RpcError {
        std::string code;
        std::string message;
    };

    using RpcResult = geode::Result<matjson::Value, RpcError>;
    // Methods always run on the game thread, so they may touch cocos freely.
    using RpcMethod = std::function<RpcResult(matjson::Value const& params)>;
    using RpcRegistry = std::unordered_map<std::string, RpcMethod>;

    inline auto fail(std::string code, std::string message) {
        return geode::Err(RpcError { std::move(code), std::move(message) });
    }

    // Entry point for the HTTP transport. Called on a server thread; hops to
    // the game thread to run the method and blocks until it has finished.
    net::Reply handleRequest(std::string const& body);

}
