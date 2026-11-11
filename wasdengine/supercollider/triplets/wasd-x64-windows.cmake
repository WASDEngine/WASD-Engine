# vcpkg triplet of the WASD Engine SuperCollider runtime on Windows x64: release libraries with the dynamic Visual C++
# runtime, static except libsndfile and FFTW, which SuperCollider's Windows build copies beside scsynth as DLLs, as
# SuperCollider's own vcpkg triplets build them. libsndfile's DLL holds its FLAC, Ogg, Vorbis, and Opus codecs.
set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
if(PORT MATCHES "^(libsndfile|fftw3)$")
    set(VCPKG_LIBRARY_LINKAGE dynamic)
endif()
set(VCPKG_BUILD_TYPE release)
