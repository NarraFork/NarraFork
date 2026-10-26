#!/bin/sh
# Throw-away PostgreSQL 16 cluster for the benchmark.
#
#   OUTLINE_BENCH_PG_DIR=<dir> ./pg-cluster.sh init|start|stop|destroy
#
# - data directory: $OUTLINE_BENCH_PG_DIR/data, unix socket: $OUTLINE_BENCH_PG_DIR/sock, port 54329.
# - unix socket paths are limited to 107 bytes, so /tmp/obpg is a symlink to the sock directory and the
#   client connects through /tmp/obpg/.s.PGSQL.54329 (see PG_SOCKET in lib.ts).
# - PostgreSQL refuses to run as root. When this script runs as root it starts the server inside a user
#   namespace that maps the postgres user (no file permissions are changed).
set -e
BASE="${OUTLINE_BENCH_PG_DIR:?set OUTLINE_BENCH_PG_DIR}"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PORT=54329
LINK=/tmp/obpg

as_pg() {
	if [ "$(id -u)" = 0 ]; then
		unshare --user --map-user="$(id -u postgres)" --map-group="$(id -g postgres)" "$@"
	else
		"$@"
	fi
}

case "$1" in
init)
	mkdir -p "$BASE/sock"
	as_pg "$PGBIN/initdb" -D "$BASE/data" -A trust -U postgres --encoding=UTF8 --locale=C.UTF-8
	cat >>"$BASE/data/postgresql.conf" <<CONF

# --- outline-bench overrides ---
port = $PORT
listen_addresses = ''
unix_socket_directories = '$LINK'
max_connections = 20
shared_buffers = 1GB
effective_cache_size = 8GB
work_mem = 32MB
maintenance_work_mem = 512MB
max_wal_size = 8GB
checkpoint_timeout = 15min
random_page_cost = 1.1
jit = off
log_min_messages = warning
CONF
	ln -sfn "$BASE/sock" "$LINK"
	;;
start)
	ln -sfn "$BASE/sock" "$LINK"
	as_pg "$PGBIN/pg_ctl" -D "$BASE/data" -l "$BASE/pg.log" -w start
	;;
stop)
	as_pg "$PGBIN/pg_ctl" -D "$BASE/data" -m fast -w stop
	;;
destroy)
	as_pg "$PGBIN/pg_ctl" -D "$BASE/data" -m fast -w stop || true
	rm -rf "$BASE/data" "$BASE/sock" "$BASE/pg.log"
	rm -f "$LINK"
	;;
*)
	echo "usage: $0 init|start|stop|destroy" >&2
	exit 2
	;;
esac
