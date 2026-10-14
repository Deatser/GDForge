#pragma once

#include <functional>
#include <string>

// Deliberately free of Geode and cocos headers: HttpServer.cpp has to include
// the socket headers before anything that drags in windows.h.
namespace gdbuilder::net {

    struct Reply {
        int status = 200;
        std::string body;
    };

    // Called on a server worker thread with the raw request body.
    using RpcHandler = std::function<Reply(std::string const& body)>;

    // Starts a localhost-only HTTP server on its own thread. Returns an empty
    // string on success, or a description of why it could not start.
    std::string startServer(int port, RpcHandler handler);

}
