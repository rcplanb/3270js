# Runtime for OS/390 (ADCD) on SDL Hyperion, alongside TK5 on the same host.
#
# Neither Hercules nor OS/390 is in the image: prepare-os390.sh puts a copy of
# Hercules (from the TK5 kit's SDL Hyperion 4.9.1 build) and the licensed
# ADCD volumes in ./os390 on the host, bind-mounted at /os390. The image
# stays small (the GPU server's image store is on a small root filesystem)
# and all state lives in one host directory.
FROM ubuntu:24.04
LABEL org.opencontainers.image.title="os390-hercules-runtime" \
      org.opencontainers.image.description="Runtime for OS/390 ADCD on SDL Hyperion (SimH Assist, 3270js)" \
      org.opencontainers.image.source="https://github.com/rcplanb/3270js"
# iproute2 and iptables: OS/390's own TCP/IP reaches the outside through a tun
# interface that Hercules creates, with NAT to the container's port (entrypoint).
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash libbz2-1.0 zlib1g libstdc++6 libgcc-s1 procps netbase iproute2 iptables \
 && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
WORKDIR /os390
# 3270 = Hercules' TN3270 (plain) port, 8038 = Hercules HTTP console,
# 2323 = OS/390's own TN3270E server (NAT to the guest's TCP/IP).
EXPOSE 3270 8038 2323
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
