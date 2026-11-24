#!/bin/bash
# Start Hercules (daemon mode, HTTP console) and, when OS390_IP is set, NAT
# the container's port 2323 to OS/390's own TN3270E server on the tun
# interface Hercules creates for the guest's network adapter.
set -euo pipefail
cd /os390
export LD_LIBRARY_PATH=/os390/hercules/lib:/os390/hercules/lib/hercules
mkdir -p logs prt

# Hercules reads commands from stdin and stops at its end: keep it open (a
# FIFO held by this script) for as long as the container runs.
rm -f /tmp/hercules.in && mkfifo /tmp/hercules.in
exec 3<>/tmp/hercules.in
/os390/hercules/bin/hercules -n -f conf/os390.cnf <&3 >> "logs/hercules-$(date +%Y%m%d).log" 2>&1 &
herc=$!
trap 'kill -TERM "$herc" 2>/dev/null; wait "$herc"' TERM INT

if [[ -n "${OS390_IP:-}" ]]; then
  # Wait for Hercules to create the interface for the guest's adapter (LCS: tap0).
  for _ in $(seq 1 60); do
    ip link show "${OS390_TUN:-tap0}" >/dev/null 2>&1 && break
    sleep 1
  done
  if ip link show "${OS390_TUN:-tap0}" >/dev/null 2>&1; then
    iptables -t nat -A PREROUTING -p tcp --dport 2323 -j DNAT --to-destination "${OS390_IP}:${OS390_TN3270_PORT:-23}"
    iptables -t nat -A POSTROUTING -o "${OS390_TUN:-tap0}" -j MASQUERADE
    echo "NAT: container :2323 -> ${OS390_IP}:${OS390_TN3270_PORT:-23}" >> "logs/hercules-$(date +%Y%m%d).log"
  else
    echo "No ${OS390_TUN:-tap0} interface: OS/390's TN3270E server is not reachable" >> "logs/hercules-$(date +%Y%m%d).log"
  fi
fi
wait "$herc"
