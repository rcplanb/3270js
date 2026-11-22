# Runtime for MVS 3.8j TK5 on the Hercules build bundled with TK5.
#
# TK5 itself is NOT baked into the image: it is unpacked on the host by
# fetch-tk5.sh and bind-mounted at /tk5. This keeps the image small (the
# GPU server's Docker image store sits on a small root filesystem) and puts
# all mutable state - DASD, logs, printer output - in one host directory.

# TK5 1.00's Hercules binaries need glibc >= 2.38 (Debian bookworm has 2.36).
FROM ubuntu:24.04
LABEL org.opencontainers.image.title="tk5-hercules-runtime" \
      org.opencontainers.image.description="Runtime for MVS 3.8j TK5 on Hercules (3270js test target)" \
      org.opencontainers.image.source="https://github.com/rcplanb/3270js"
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash libbz2-1.0 zlib1g libstdc++6 libgcc-s1 procps \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /tk5
# 3270 = TN3270 terminal port, 8038 = Hercules HTTP console.
EXPOSE 3270 8038
CMD ["/tk5/mvs"]
