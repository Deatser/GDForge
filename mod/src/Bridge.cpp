#include "Bridge.hpp"

#include "GameThread.hpp"
#include "rpc/Rpc.hpp"

#include <chrono>
#include <future>

using namespace geode::prelude;

namespace gdbuilder {

    namespace {
        RpcRegistry const& registry() {
            static RpcRegistry const methods = [] {
                RpcRegistry registry;
                rpc::registerStatus(registry);
                rpc::registerEditor(registry);
                rpc::registerObjects(registry);
                rpc::registerLevels(registry);
                rpc::registerCatalog(registry);
                rpc::registerPlaytest(registry);
                rpc::registerScreenshot(registry);
                return registry;
            }();
            return methods;
        }

        net::Reply errorReply(int status, std::string code, std::string message) {
            auto error = matjson::makeObject({
                { "code", std::move(code) },
                { "message", std::move(message) },
            });
            auto body = matjson::makeObject({ { "ok", false }, { "error", std::move(error) } });
            return { status, body.dump(matjson::NO_INDENTATION) };
        }

        RpcResult invoke(std::string const& method, matjson::Value const& params) {
            auto it = registry().find(method);
            if (it == registry().end()) {
                return fail("unknown_method", "Unknown method \"" + method + "\"");
            }
            // An exception escaping into the cocos scheduler would take the game down with it
            try {
                return it->second(params);
            }
            catch (std::exception const& e) {
                return fail("internal", e.what());
            }
        }
    }

    net::Reply handleRequest(std::string const& body) {
        auto parsed = matjson::parse(body);
        if (!parsed) {
            return errorReply(400, "bad_request", "Request body is not valid JSON");
        }
        auto request = std::move(parsed).unwrap();
        auto method = request["method"].asString();
        if (!method) {
            return errorReply(400, "bad_request", "Request is missing \"method\"");
        }

        auto promise = std::make_shared<std::promise<RpcResult>>();
        auto future = promise->get_future();
        runOnGameThread([promise, name = std::move(method).unwrap(), params = request["params"]] {
            promise->set_value(invoke(name, params));
        });

        if (future.wait_for(std::chrono::seconds(30)) != std::future_status::ready) {
            return errorReply(
                504, "timeout",
                "Geometry Dash did not respond within 30 seconds. It may still be loading or be busy; "
                "bring its window to the front. The request may still be applied once the game catches up."
            );
        }

        auto result = future.get();
        if (!result) {
            auto error = std::move(result).unwrapErr();
            return errorReply(200, std::move(error.code), std::move(error.message));
        }
        auto reply = matjson::makeObject({ { "ok", true }, { "result", std::move(result).unwrap() } });
        return { 200, reply.dump(matjson::NO_INDENTATION) };
    }

}
