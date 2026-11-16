#!/bin/sh
set -eu
drop=""
if [ "${RELAYRUNNER_LOCAL_NETWORK:-}" != 1 ]; then
  drop="--bounding-set -net_admin,-net_raw"
  dns=$(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ { printf "%s%s", sep, $2; sep = ", " }' /etc/resolv.conf)
  allow_dns=""
  [ -z "$dns" ] || allow_dns="ip daddr { $dns } meta l4proto { tcp, udp } th dport 53 accept"
  nft -f - <<EOF
table inet relayrunner {
  chain private {
    oifname { "lo", "docker0" } accept
    oifname "br-*" accept
    $allow_dns
    ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } drop
    meta nfproto ipv6 drop
  }
  chain out {
    type filter hook output priority 0; policy accept;
    jump private
  }
  chain forward {
    type filter hook forward priority 0; policy accept;
    jump private
  }
}
EOF
fi
# Docker sets kernel network settings under /proc/sys, which starts read-only. A job without
# Docker loses nothing if it can't start, so failures here only reach the Docker log.
if command -v dockerd >/dev/null 2>&1; then
  mount -o remount,rw /proc/sys 2>/dev/null || true
  dockerd >/var/log/dockerd.log 2>&1 &
  tries=0
  until docker info >/dev/null 2>&1 || [ "$tries" -ge 50 ]; do
    tries=$((tries + 1))
    sleep 0.2
  done
fi
# A new VM's DNS answers nothing for its first 2 seconds or so, and a lookup sent then waits 5
# seconds to ask again. So the runner starts once a lookup gets through, or after 5 tries.
tries=0
until RES_OPTIONS="timeout:1 attempts:1" getent hosts github.com >/dev/null 2>&1 || [ "$tries" -ge 4 ]; do
  tries=$((tries + 1))
done
cd /home/runner
# With arguments, runs them in place of the runner, to check the VM by hand.
[ $# -gt 0 ] || set -- ./run.sh --jitconfig "$RUNNER_JIT_CONFIG"
exec setpriv --reuid runner --regid runner --init-groups $drop \
  env HOME=/home/runner USER=runner LOGNAME=runner "$@"
