#!/bin/sh
# DHCP hook for busybox udhcpc — used when pebblesd is the init of a system
# container (Incus) and must configure networking itself. Docker/Podman configure
# the netns before our init runs, and pebblesd skips DHCP entirely there.
case "$1" in
  bound|renew)
    busybox ip addr flush dev "$interface"
    busybox ip addr add "$ip/$mask" dev "$interface"
    if [ -n "$router" ]; then
      busybox ip route del default 2>/dev/null || true
      for r in $router; do
        busybox ip route add default via "$r" dev "$interface" && break
      done
    fi
    if [ -n "$dns" ]; then
      : > /etc/resolv.conf
      for d in $dns; do echo "nameserver $d" >> /etc/resolv.conf; done
    fi
    ;;
  deconfig)
    busybox ip addr flush dev "$interface" 2>/dev/null || true
    ;;
esac
