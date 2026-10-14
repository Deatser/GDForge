#include <httplib.h>

#include "HttpServer.hpp"

#include <memory>
#include <thread>

namespace gdbuilder::net {

    namespace {
        constexpr auto JSON = "application/json";

        // The bridge can rewrite the open level, so only a local MCP server may
        // talk to it. Browsers are the realistic way a remote party reaches
        // 127.0.0.1, and all three checks below reject them:
        //  - Origin is set by browsers on cross-site requests
        //  - the custom header cannot be sent cross-site without a CORS
        //    preflight, which is never answered
        //  - the Host check defeats DNS rebinding
        bool isLocalHost(std::string const& host) {
            auto name = host.substr(0, host.rfind(':'));
            return name == "127.0.0.1" || name == "localhost";
        }

        bool isTrusted(httplib::Request const& req) {
            return !req.has_header("Origin")
                && req.get_header_value("X-GDBuilder") == "1"
                && isLocalHost(req.get_header_value("Host"));
        }

        void reject(httplib::Response& res) {
            res.status = 403;
            res.set_content(
                R"({"ok":false,"error":{"code":"forbidden","message":"Only the local GDBuilder MCP server may use this endpoint"}})",
                JSON
            );
        }
    }

    std::string startServer(int port, RpcHandler handler) {
        auto server = std::make_shared<httplib::Server>();
        server->set_payload_max_length(64 * 1024 * 1024);

        server->Post("/rpc", [handler](httplib::Request const& req, httplib::Response& res) {
            if (!isTrusted(req)) return reject(res);
            auto reply = handler(req.body);
            res.status = reply.status;
            res.set_content(reply.body, JSON);
        });

        if (!server->bind_to_port("127.0.0.1", port)) {
            return "port " + std::to_string(port) + " is already in use";
        }

        std::thread([server] { server->listen_after_bind(); }).detach();
        return {};
    }

}
