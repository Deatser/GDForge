cmake_minimum_required(VERSION 3.21)
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Release builds are universal; pass -DCMAKE_OSX_ARCHITECTURES=arm64 for faster local builds
if (NOT DEFINED CMAKE_OSX_ARCHITECTURES)
    set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64")
endif()
set(CMAKE_CXX_VISIBILITY_PRESET hidden)

project(GDForge VERSION 0.3.0)

file(GLOB_RECURSE SOURCES CONFIGURE_DEPENDS src/*.cpp)

add_library(${PROJECT_NAME} SHARED ${SOURCES})

if (NOT DEFINED ENV{GEODE_SDK})
    message(FATAL_ERROR "Unable to find Geode SDK! Please define GEODE_SDK environment variable to point to Geode")
else()
    message(STATUS "Found Geode: $ENV{GEODE_SDK}")
endif()

add_subdirectory($ENV{GEODE_SDK} ${CMAKE_CURRENT_BINARY_DIR}/geode)

# Header-only HTTP server. Only the header is used (no TLS, no compression), so
# skip its CMake project to keep it from picking up whatever OpenSSL/zlib the
# build machine happens to have.
CPMAddPackage(
    NAME httplib
    GITHUB_REPOSITORY yhirose/cpp-httplib
    GIT_TAG v0.58.0
    DOWNLOAD_ONLY YES
)
target_include_directories(${PROJECT_NAME} PRIVATE ${httplib_SOURCE_DIR})

# The transport must see winsock2.h before windows.h, which the Geode
# precompiled header would otherwise pull in first.
set_source_files_properties(src/net/HttpServer.cpp PROPERTIES SKIP_PRECOMPILE_HEADERS ON)

setup_geode_mod(${PROJECT_NAME})
