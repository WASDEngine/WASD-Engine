# vcpkg triplet of the WASD Engine SuperCollider runtime on Linux arm64: static, position-independent release libraries,
# which build.sh links into sclang, scsynth, and the UGen plugins.
set(VCPKG_TARGET_ARCHITECTURE arm64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CMAKE_SYSTEM_NAME Linux)
set(VCPKG_BUILD_TYPE release)
