#!/usr/bin/env bash
# podtree.sh - Kubernetes  node > namespace > pod  tree with logs, events, network views and live stats, in plain bash.
# 제작자: 김태동 <rilak0514@metabuild.co.kr>
#
# Needs: bash 4+, kubectl, awk, sort.  Optional: less (scrolling), tcpdump / ssh / a debug image (packet capture),
# metrics-server (kubectl top columns).  One file, no other dependencies - copy it to any (air-gapped) server.
#
#   ./podtree.sh                   all namespaces, tree: node > namespace > pod
#   ./podtree.sh -n kube-system    one namespace
#   ./podtree.sh -g ns,wl          namespace > workload > pod
#   ./podtree.sh --lang en         English UI (default: Korean when the terminal / server locale can show it)
#
# Press ? inside for the full key list.

VERSION="2.4.0-dachsterm.1"
umask 077
export LESSSECURE=1
DACHSTERM_STAGE=${BASH_SOURCE[0]%/*}
readonly DACHSTERM_STAGE

NS="" INTERVAL=5 TAIL=500 GROUP="node,ns" ASCII=0 COLOR=1 LANG_OPT=auto BELL=0 READONLY=0 SORT=name WIDE=0 TOPON=1 DETAIL=1
AI_ON=1 AI_INTERVAL=10 AI_PID="" AI_DIR="" AI_LAST=0 AI_STATUS="starting" AI_STAMP=0
declare -A AI_DATA=() AI_MODELS=() AI_STATE=() AI_TYPE=() AI_SEEN=() AI_ENDPOINT=() AI_GPU=() AI_GPU_SEEN=() AI_NODE_GPU=() AI_GPU_PODS=()
# V monitor: per model / pod integer fields, trend series, change log, fold state (see ai_hist)
declare -A AI_M=() AI_P=() AI_MP=() AI_H=() AI_PMODEL=() AI_PNODE=() AI_PSTATE_PREV=() AI_STALL=() AI_KVHI=() AI_POD_GPU=() AI_GPU_ROWS=()
declare -A AI_FOLD=() AI_XP=() AI_PIDX=() AI_CW=([pods]=5 [run]=8 [wait]=8 [load]=12 [done]=6 [dpm]=7 [dtrend]=10 [kv]=10 [out]=7 [in]=7 [ttft]=6 [e2e]=6 [queue]=6 [gpu]=4 [vram]=9 [cpu]=6 [mem]=7 [total]=7)
AI_MLIST=() AI_EV=() AI_NSAMPLE=0 AI_HN=40 AI_FAST=0 AI_FOLDDEF="" AI_SORT=name AI_EVSHOW=1 AI_NA=$'\001na' VR_KIND=() VR_KEY=() VC=() VNAME_W=24
KARGS=() KCTX=""
DEBUG_IMAGE=${PODTREE_DEBUG_IMAGE:-} SSH_TPL=${PODTREE_SSH:-} LOCAL_NODE=${PODTREE_LOCAL_NODE:-}
FILTER="" FILTER_WORDS=() FILTER_NOT=() MATCHED=0 PROBLEMS=0 MARKEDONLY=0 DEFAULT_FOLDED=0 INT_HIT=0
declare -A FOLDED=() CNT=() BAD=() RSUM=() NODEINFO=() NODE_ADDR=() NODE_COND=() NODE_ALLOC=() NODE_CAP=() NODE_TAINT=() NODE_VER=() NODE_ROLE=() NODE_MISC=() NODE_CIDR=()
declare -A MARK=() PREV_SIG=() BASE_RS=() CHG=() NEWP=() TOP_CPU=() TOP_MEM=() TOPN=() TOPN_CPU=() TOPN_MEM=()
P_NODE=() P_NS=() P_NAME=() P_READY=() P_STATUS=() P_RESTARTS=() P_RAGO=() P_AGE=() P_BAD=() P_IP=() P_HIP=() P_OWNER=() P_WL=()
P_CTR=() P_LABELS=() P_PORTS=() P_VOLS=() P_QOS=() P_HOSTNET=() P_RES=() P_AGES=() P_CNAMES=() P_INAMES=() P_SA=() P_CONDS=()
R_KIND=() R_KEY=() R_DEPTH=() R_IDX=()
SEL=0 TOP=0 SEL_KEY="" DIRTY=1 ERR="" LAST_REFRESH="" MSG="" CTX="" KEY="" LINE="" NAME_W=20 S="" NOW=0
LINES=24 COLUMNS=80 FETCH_PID="" LAST_FETCH=0 FIRST_LOAD=1 BADCOUNT=0 PRODS=() DISP_PID="" COLORIZE=none STREAM_TS=0
LOADED=0 NPODS=0
# status panel (w): node health / usage, pod + workload health, recent Warning events, always on top of the tree
PANEL=1 PANEL_H=0 BODY_H=10 IN_DASH=0
declare -A NODE_RQC=() NODE_RQM=() NODE_NP=() NODE_NB=()
NODE_ORDER=() WL_ITEMS=() WL_TOTAL=0 WL_OK=0 WL_ROLL=0 WL_SHORT=0 WL_FAIL=0 WL_HAVE=0
ST_RUN=0 ST_PEND=0 ST_CRASH=0 ST_OTHER=0 RS_GROW=0 RS_TOPK="" EV_HAVE=0 EV_N=0 EV_TOP="" EV_AGE="" EV_OBJ="" EV_REASON="" EV_MSG=""
declare -A NODE_RR=() NODE_RSINCE=() WLS=() XRS=() H_NODE=() H_POD=() H_WL=() H_XR=()
P_RSEC=() P_OOM=() ST_RREC=0 ST_OOM=0 XR_PVC=0 XR_JOB=0 XR_HPA=0 H_RECENT=() H_CNT=0 H_INIT=0 H_RING=0 NEWDATA=0 LT=""

usage() {
    cat <<EOF
usage: podtree.sh [options]
  -n, --namespace NS     show only this namespace (default: all)
  --context CTX          kubectl context          --kubeconfig FILE
  -i, --interval SEC     auto-refresh period, 0 = manual (default 5)
  --tail N               log lines to start with (default 500)
  -g, --group LEVELS     node,ns (default) | ns | ns,wl | node        (wl = workload: Deployment, StatefulSet, ...)
  -o, --sort KEY         name | status | restarts | age
  --wide                 IP / NODE / OWNER columns on      --top     CPU / MEM columns on (needs metrics-server)
  --no-top               hide CPU / MEM columns (shown by default)
  --no-ai                disable automatic vLLM / DCGM discovery and monitoring (default on; V = details)
  --lang ko|en|auto      UI language (auto: Korean when the locale is UTF-8, else English)
  --bell                 terminal bell when the number of problem pods grows
  --read-only            query only: blocks writes, exec, debug, capture, forwarding and raw proxy
  --no-panel             start with the status panel (nodes, workloads, warnings) hidden - w toggles it
  --ascii                - + instead of unicode tree markers       --no-color
  -V, --version   -h, --help
Environment: PODTREE_DEBUG_IMAGE (image with tcpdump for kubectl debug), PODTREE_SSH (e.g. root@%h : ssh to nodes),
             PODTREE_LOCAL_NODE (this machine's node name if it differs from hostname), KUBECTL (kubectl binary).
Config file ~/.podtreerc: one option per line, e.g.  interval=10   group=ns,wl   lang=en   debug_image=registry/netshoot
EOF
}

# ~/.podtreerc: simple key=value lines (not sourced)
if [[ -z ${DACHSTERM_EMBEDDED:-} && -r ~/.podtreerc ]]; then
    while IFS='=' read -r k v; do
        k=${k//[[:space:]]/}; v=${v#"${v%%[![:space:]]*}"}; v=${v%"${v##*[![:space:]]}"}
        case $k in
            namespace) NS=$v ;; interval) INTERVAL=$v ;; tail) TAIL=$v ;; group) GROUP=$v ;; sort) SORT=$v ;;
            lang) LANG_OPT=$v ;; bell) BELL=$v ;; read_only|readonly) READONLY=$v ;; wide) WIDE=$v ;; top) TOPON=$v ;;
            ascii) ASCII=$v ;; color) COLOR=$v ;; panel) PANEL=$v ;; ai) AI_ON=$v ;; debug_image) DEBUG_IMAGE=$v ;; ssh) SSH_TPL=$v ;; local_node) LOCAL_NODE=$v ;;
            context) KARGS+=(--context "$v"); KCTX=$v ;; kubeconfig) KARGS+=(--kubeconfig "$v") ;;
        esac
    done <~/.podtreerc
fi
while (($#)); do
    case $1 in
        -n|--namespace) NS=$2; shift 2 ;;
        --context) KARGS+=("$1" "$2"); KCTX=$2; shift 2 ;;
        --kubeconfig) KARGS+=("$1" "$2"); shift 2 ;;
        -i|--interval) INTERVAL=$2; shift 2 ;;
        --tail) TAIL=$2; shift 2 ;;
        -g|--group) GROUP=$2; shift 2 ;;
        -o|--sort) SORT=$2; shift 2 ;;
        --lang) LANG_OPT=$2; shift 2 ;;
        --wide) WIDE=1; shift ;;
        --top) TOPON=1; shift ;;
        --no-top) TOPON=0; shift ;;
        --no-ai) AI_ON=0; shift ;;
        --bell) BELL=1; shift ;;
        --read-only) READONLY=1; shift ;;
        --ascii) ASCII=1; shift ;;
        --no-color) COLOR=0; shift ;;
        --collapsed) DEFAULT_FOLDED=1; shift ;;
        --no-panel) PANEL=0; shift ;;
        -V|--version) echo "podtree.sh $VERSION"; exit 0 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "podtree.sh: unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done
case $GROUP in node,ns|ns|ns,wl|node) ;; *) echo "podtree.sh: -g must be node,ns | ns | ns,wl | node" >&2; exit 2 ;; esac
case $SORT in name|status|restarts|age) ;; *) echo "podtree.sh: -o must be name | status | restarts | age" >&2; exit 2 ;; esac
((BASH_VERSINFO[0] >= 4)) || { echo "podtree.sh: needs bash 4 or newer" >&2; exit 1; }
KUBECTL=${KUBECTL:-kubectl}
command -v "$KUBECTL" >/dev/null 2>&1 || { echo "podtree.sh: kubectl not found in PATH" >&2; exit 1; }
[[ -t 0 && -t 1 ]] || { echo "podtree.sh: needs an interactive terminal" >&2; exit 1; }
kc() {
    if ((READONLY)); then
        case $1 in get|describe|logs|top|config|auth) ;; *) echo 'DachsTerm: read-only action blocked' >&2; return 126 ;; esac
        # Raw proxy requests can reach application endpoints; disable them in query mode.
        local arg; for arg in "$@"; do [[ $arg == --raw* ]] && { echo 'DachsTerm: raw API disabled in query mode' >&2; return 126; }; done
    fi
    "$KUBECTL" "${KARGS[@]}" "$@"
}

# ---------------------------------------------------------------- terminal / locale / language
# SSH sessions (MobaXterm etc.) often arrive with LANG unset.  Switch to a UTF-8 locale when the server has one,
# so Korean and other multibyte text works in the UI, prompts, less and grep.
UTF8=0
if ((ASCII == 0)) || [[ $LANG_OPT == ko ]]; then
    case "$(locale charmap 2>/dev/null)" in
        UTF-8|utf8|UTF8) ;;
        *)  for l in C.UTF-8 C.utf8 en_US.UTF-8 en_US.utf8 ko_KR.UTF-8 ko_KR.utf8; do
                if locale -a 2>/dev/null | grep -qixF -- "$l"; then export LC_ALL=$l LANG=$l; break; fi
            done ;;
    esac
    export LESSCHARSET=${LESSCHARSET:-utf-8}
fi
case "$(locale charmap 2>/dev/null)" in UTF-8|utf8|UTF8) UTF8=1 ;; *) ASCII=1 ;; esac
case $LANG_OPT in
    ko) UI=ko ;;
    en) UI=en ;;
    *)  UI=en; ((UTF8)) && UI=ko ;;      # auto: Korean whenever the terminal can show it, else English
esac
set_glyphs() {
    if ((ASCII)); then G_OPEN="-"; G_CLOSED="+"; SEP=" | "; G_MARK="*"; G_CHG="*"; G_NEW="+"; G_OK="v"; G_NG="x"; G_RS="r"; G_DOT="o"; G_VB="|"; G_ELL=".."; G_TO="->"
         G_UP="^"; G_DN="v"; G_FULL="#"; G_EMPTY="."; G_HR="-"; G_SPK=(_ . , : - = + '#')
    else G_OPEN="▾"; G_CLOSED="▸"; SEP=" · "; G_MARK="★"; G_CHG="Δ"; G_NEW="+"; G_OK="✓"; G_NG="✗"; G_RS="↻"; G_DOT="●"; G_VB="│"; G_ELL="…"; G_TO="→"
         G_UP="▲"; G_DN="▼"; G_FULL="█"; G_EMPTY="░"; G_HR="─"; G_SPK=(▁ ▂ ▃ ▄ ▅ ▆ ▇ █); fi
}
set_glyphs
if ((COLOR)); then
    C_OK=$'\e[32m' C_WARN=$'\e[33m' C_BAD=$'\e[1;31m' C_NS=$'\e[36m' C_DIM=$'\e[2m' C_BOLD=$'\e[1m' C_END=$'\e[22;39m' C_MAG=$'\e[35m' C_BLUE=$'\e[34m'
else
    C_OK="" C_WARN="" C_BAD="" C_NS="" C_DIM="" C_BOLD="" C_END="" C_MAG="" C_BLUE=""
fi
C_REV=$'\e[7m' C_UL=$'\e[4m' C_RST=$'\e[0m'

TMP=$(mktemp -d "${TMPDIR:-/tmp}/podtree.XXXXXX") || exit 1
if command -v stdbuf >/dev/null 2>&1; then STDBUF=(stdbuf -oL); else STDBUF=(); fi
LESSKEY_OPT=()
printf '#command\n\\e\\e quit\n\\eq quit\n' >"$TMP/lesskey.src"
if command -v lesskey >/dev/null 2>&1 && lesskey -o "$TMP/lesskey.bin" "$TMP/lesskey.src" >/dev/null 2>&1; then
    LESSKEY_OPT=(-k "$TMP/lesskey.bin")
else
    LESS_VER=$(less --version 2>/dev/null | awk 'NR == 1 { print $2 + 0 }')
    [[ $LESS_VER =~ ^[0-9]+$ ]] && ((LESS_VER >= 582)) && LESSKEY_OPT=(--lesskey-src="$TMP/lesskey.src")
fi
HAVE_LESS=0; command -v less >/dev/null 2>&1 && HAVE_LESS=1
TTY_STATE=""
enter_screen() {
    # read -s silences only the read itself. Held keys can otherwise echo while draw
    # is running, wrap at the bottom of the screen and scroll the header away.
    [[ -n $TTY_STATE ]] || TTY_STATE=$(stty -g 2>/dev/null)
    stty -echo -echonl -icanon -ixon min 1 time 0 2>/dev/null
    printf '\e[?1049h\e[H\e[2J\e[?25l'
    DIRTY=1
}
leave_screen() {
    printf '\e[0m\e[?7h\e[?25h\e[?1049l'
    # Shells, pagers, and the caller must get their original terminal settings back.
    if [[ -n $TTY_STATE ]]; then stty "$TTY_STATE" 2>/dev/null; TTY_STATE=""; fi
}
dachsterm_kill_children() {
    local parent=$1 child
    local children; children=$(ps -eo pid=,ppid= | awk -v p="$parent" '$2==p {print $1}')
    for child in $children; do dachsterm_kill_children "$child"; kill -TERM "$child" 2>/dev/null; done
}
cleanup() { trap '' HUP TERM INT; dachsterm_kill_children "$$"; stop_producers; [[ -n $FETCH_PID ]] && kill "$FETCH_PID" 2>/dev/null; [[ -n $AI_PID ]] && ai_stop; leave_screen; rm -rf "$TMP";
    if [[ ${DACHSTERM_EMBEDDED:-} == 1 && $DACHSTERM_STAGE == /*/dachsterm-podtree.* ]]; then
        rm -f -- "$DACHSTERM_STAGE/podtree.sh"; rmdir -- "$DACHSTERM_STAGE" 2>/dev/null
    fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
trap 'DIRTY=1' WINCH
now_epoch() { printf -v NOW '%(%s)T' -1 2>/dev/null || NOW=$(date +%s); }

# pad VAR TEXT WIDTH  (ascii text, no subshell) ;  padw: same but multibyte-aware (Korean = 2 columns)
pad() {
    local s=$2 w=$3
    ((w < 0)) && w=0
    ((${#s} > w)) && s=${s:0:w}
    printf -v "$1" '%-*s' "$w" "$s"
}
dw() {   # dw VAR TEXT -> display width; CJK chars count 2 (chars + (bytes - chars) / 2), our 1-column glyphs excluded
    local s=$2 c b
    ((UTF8)) && s=${s//[▾▸·★Δ✓✗↻●│…↑↓←→▲▼▁▂▃▄▅▆▇█░─]/x}
    c=${#s}
    local LC_ALL=C
    b=${#s}
    printf -v "$1" '%d' $((c + (b - c) / 2))
}
padw() {
    local s=$2 w=$3 d
    ((w < 0)) && w=0
    dw d "$s"
    while ((d > w)) && [[ -n $s ]]; do s=${s%?}; dw d "$s"; done
    printf -v "$1" '%s%*s' "$s" $((w - d)) ''
}

# ---------------------------------------------------------------- messages (en / ko)
declare -A M_en=() M_ko=()
msg() { M_en[$1]=$2; M_ko[$1]=$3; }
t() { local v="M_$UI[$1]"; S=${!v}; [[ -z $S ]] && S=${M_en[$1]}; }   # t KEY -> S
msg hint     " ↑↓←→ move  Enter logs  V GPU/vLLM  s shell  L grep  m select  M marked-logs  e events  v relations  N net  T tcpdump  D dash  w panel  / filter  ! bad  I problems  H changes  ? help  q quit" \
             " ↑↓←→ 이동  Enter 로그  V GPU/vLLM  s 셸  L 로그필터  m 선택  M 선택로그  e 이벤트  v 연결관계  N 네트워크  T 덤프  D 대시보드  w 상태판  / 필터  ! 문제파드  I 문제목록  H 변화  ? 도움말  q 종료"
msg hint_s   " ↑↓←→  Enter logs  V GPU/vLLM  s shell  / filter  ! problems  ? help  q quit" " ↑↓←→  Enter 로그  V GPU/vLLM  s 셸  / 필터  ! 문제파드  ? 도움말  q 종료"
msg pods "pods" "파드"; msg nodes "nodes" "노드"; msg notready "not ready" "비정상"; msg restarts "restarts" "재시작"
msg loading "loading..." "불러오는 중..."; msg refreshing "refreshing..." "갱신 중..."; msg nomatch "no pods match" "일치하는 파드 없음"; msg nopods "no pods" "파드 없음"
msg kfail "kubectl failed: %s" "kubectl 실패: %s"; msg problems "[problems only]" "[문제 파드만]"; msg markedonly "[selected only]" "[선택한 파드만]"
msg unsched "(unscheduled)" "(미배치)"; msg pending_nonode "pending, no node" "대기 중, 노드 없음"; msg notnode "not a real node" "실제 노드가 아님"
msg selpod "select a pod first" "먼저 파드를 선택하세요"; msg selnode "select a node first" "먼저 노드를 선택하세요"; msg readonly "read-only mode" "읽기 전용 모드"
msg group "grouping: %s" "트리 단계: %s"; msg sort "sort: %s" "정렬: %s"; msg marked "%d pods selected" "선택한 파드 %d개"; msg nomarked "no pods selected (m)" "선택한 파드가 없습니다 (m)"
msg wide_on "IP / NODE / OWNER columns on" "IP / 노드 / 소유자 컬럼 켬"; msg wide_off "extra columns off" "추가 컬럼 끔"
msg top_on "CPU / MEM columns on (kubectl top)" "CPU / MEM 컬럼 켬 (kubectl top)"; msg top_off "CPU / MEM columns off" "CPU / MEM 컬럼 끔"; msg top_fail "kubectl top failed (metrics-server?)" "kubectl top 실패 (metrics-server 없음?)"
msg filter_p "filter: " "필터: "; msg filter_h "(Enter keep, Esc cancel, words = all must match, !word = exclude; matches ns/name/node/status/owner)" "(Enter 확정, Esc 취소, 단어 모두 일치, !단어 = 제외, 대상: 네임스페이스/이름/노드/상태/소유자)"
msg logpat_p "show only log lines matching (text or regex, any case): " "이 패턴의 로그 줄만 (텍스트/정규식, 대소문자 무시): "
msg livepat_p "only lines matching (text or regex, empty = all): " "일치하는 줄만 (텍스트/정규식, 비우면 전체): "
msg logs "logs" "로그"; msg logs_prev "previous logs" "이전 인스턴스 로그"; msg multilogs "logs of %d pods" "파드 %d개 로그"; msg only "only:" "필터:"
msg stream_h " Esc/q back   Space/Enter: browse (less)   & or /: live filter   S save   (other keys ignored)" " Esc/q 복귀   Space/Enter: 둘러보기(less)   & 또는 /: 실시간 필터   S 저장   (다른 키 무시)"
msg stream_end "--- stream ended ---   Esc or q: back      Space or Enter: browse" "--- 스트림 종료 ---   Esc 또는 q: 복귀      Space 또는 Enter: 둘러보기"
msg less_p "Esc Esc or q returns | F follows (Ctrl-C stops) | /text searches | &text filters" "Esc Esc 또는 q 복귀 | F 따라가기 (Ctrl-C 중지) | /검색 | &필터"
msg less_p2 "Esc Esc or q returns" "Esc Esc 또는 q 복귀"; msg noless "[less is not installed, cannot browse]  press Enter" "[less가 없어 둘러보기 불가]  Enter"
msg saved "saved: %s" "저장: %s"; msg save_fail "save failed" "저장 실패"; msg press_enter "press Enter to return" "Enter를 누르면 돌아갑니다"
msg ai_title " GPU / vLLM monitor  ctx:%s  ns:%s   %s models · %s/%s pods answering   sampled %ss ago, every %ss" " GPU / vLLM 모니터  ctx:%s  ns:%s   모델 %s · 파드 %s/%s 응답   %s초 전 수집, %s초 주기"
msg ai_hint " ↑↓ move  ←→ Enter fold  +/- all  d details  e change pane  L change log  o sort:%s  t tree  r collect  S save  q back" " ↑↓ 이동  ←→ Enter 접기/펼치기  +/- 전체  d 상세  e 변화창  L 변화로그  o 정렬:%s  t 트리로  r 수집  S 저장  q 복귀"
msg ai_hint_s " ←→ fold  d details  L changes  o sort:%s  q back" " ←→ 접기  d 상세  L 변화로그  o 정렬:%s  q 복귀"
msg ai_collecting "[collecting]" "[수집 중]"; msg ai_wait "collecting the first sample..." "첫 수집 중..."
msg ai_none "no vLLM pods found (custom image? annotate podtree.io/monitor=vllm)  d/a: collection status" "vLLM 파드를 찾지 못함 (다른 이미지면 podtree.io/monitor=vllm 어노테이션)  d/a: 수집 상태"
msg ai_norows "nothing to show yet" "아직 표시할 항목 없음"; msg ai_na "(no metrics)" "(수집 불가)"; msg ai_gpusec "GPU workers (DCGM)" "GPU 워커 (DCGM)"
msg ai_evtitle "vLLM changes" "vLLM 변화"; msg ai_evnone "no change yet - compared from the second collection" "아직 변화 없음 - 두 번째 수집부터 비교합니다"
msg ai_t_run "TOTAL  run" "합계  실행"; msg ai_t_wait "wait" "대기"; msg ai_t_done "done +%s in %ss (%s/min)" "완료 +%s/%s초 (%s/분)"; msg ai_t_done0 "done -" "완료 -"
msg ai_t_out "out %s tok/s" "출력 %s tok/s"; msg ai_t_kv "KV max %s%%" "KV 최대 %s%%"; msg ai_t_gpu "GPU max %s%%" "GPU 최대 %s%%"
msg ai_t_ttft "first token %s" "첫 토큰 %s"; msg ai_t_total "total done %s" "누적 완료 %s"
msg ai_h_name "MODEL / POD  node" "모델 / 파드  노드"; msg ai_h_pods "PODS" "파드"; msg ai_h_run "RUN" "실행"; msg ai_h_wait "WAIT" "대기"
msg ai_h_load "LOAD TREND" "부하 추이"; msg ai_h_done "DONE" "완료"; msg ai_h_dpm "DONE/m" "완료/분"; msg ai_h_dtrend "DONE TREND" "완료 추이"
msg ai_h_kv "KV CACHE" "KV 캐시"; msg ai_h_out "OUT t/s" "출력t/s"; msg ai_h_in "IN t/s" "입력t/s"; msg ai_h_ttft "TTFT" "첫토큰"; msg ai_h_e2e "E2E" "응답"
msg ai_h_queue "QUEUE" "큐대기"; msg ai_h_gpu "GPU" "GPU"; msg ai_h_vram "VRAM" "VRAM"; msg ai_h_cpu "CPU" "CPU"; msg ai_h_mem "MEM" "MEM"; msg ai_h_total "TOTAL" "누적"
msg exec_h "[podtree] kubectl exec -it %s   (exit to return)" "[podtree] kubectl exec -it %s   (exit 로 복귀)"; msg exit_rc "[exit %d]  press Enter to return" "[종료 코드 %d]  Enter를 누르면 돌아갑니다"
msg pick_ctr "container:" "컨테이너:"; msg pick_ns "namespace (Esc = all):" "네임스페이스 (Esc = 전체):"; msg pick_ctx "kubectl context:" "kubectl 컨텍스트:"
msg all_ctr "all containers" "모든 컨테이너"; msg all_ns "(all namespaces)" "(전체 네임스페이스)"; msg pick_h "↑↓ move  Enter select  Esc cancel  type to filter" "↑↓ 이동  Enter 선택  Esc 취소  글자 입력 = 필터"
msg events "events" "이벤트"; msg events_live "warning events (live)" "경고 이벤트 (실시간)"; msg no_events "no events" "이벤트 없음"
msg rel "relations" "연결 관계"; msg netstat "network stats" "네트워크 상태"; msg tcpdump "packet capture" "패킷 캡처"; msg dash "dashboard" "대시보드"
msg pf_p "port-forward local:remote (Enter = %s): " "포트포워드 로컬:원격 (Enter = %s): "; msg pf "port-forward" "포트포워드"
msg confirm_del "delete pod %s ? (y/N) " "파드 %s 를 삭제할까요? (y/N) "; msg confirm_rr "rollout restart %s ? (y/N) " "%s 를 rollout restart 할까요? (y/N) "
msg confirm_cordon "cordon node %s ? (y/N) " "노드 %s 를 cordon 할까요? (y/N) "; msg confirm_uncordon "uncordon node %s ? (y/N) " "노드 %s 를 uncordon 할까요? (y/N) "
msg cancelled "cancelled" "취소"; msg done_ "done: %s" "완료: %s"; msg no_owner "no restartable owner (Deployment/StatefulSet/DaemonSet)" "재시작할 소유자 없음 (Deployment/StatefulSet/DaemonSet)"
msg tcp_method "capture method:" "캡처 방법:"; msg tcp_preset "capture filter:" "캡처 필터:"; msg tcp_count "packet count (Enter = %s): " "패킷 수 (Enter = %s): "
msg tcp_m_local "on this node with local tcpdump (pod is on this host)" "이 서버의 tcpdump 로 (파드가 이 호스트에 있음)"
msg tcp_m_exec "tcpdump inside the container (kubectl exec)" "컨테이너 안의 tcpdump 로 (kubectl exec)"
msg tcp_m_debug "ephemeral debug container %s (kubectl debug --profile=netadmin)" "임시 디버그 컨테이너 %s (kubectl debug --profile=netadmin)"
msg tcp_m_ssh "ssh to node %s and run tcpdump there" "노드 %s 에 ssh 로 들어가 tcpdump 실행"
msg tcp_none "no capture method available: tcpdump is not in the container, PODTREE_DEBUG_IMAGE and PODTREE_SSH are unset, and the pod is not on this host" "캡처 방법 없음: 컨테이너에 tcpdump 없음, PODTREE_DEBUG_IMAGE / PODTREE_SSH 미설정, 파드가 이 호스트에 없음"
msg tcp_p_hs "TCP handshake only (SYN, SYN-ACK, RST)" "TCP 핸드셰이크만 (SYN, SYN-ACK, RST)"; msg tcp_p_port "one port (asks which)" "특정 포트 (입력)"
msg tcp_p_host "one remote host (asks which)" "특정 상대 호스트 (입력)"; msg tcp_p_rst "resets and retransmissions only (RST)" "리셋만 (RST)"; msg tcp_p_all "everything (careful on busy pods)" "전부 (바쁜 파드에서는 주의)"
msg tcp_p_custom "custom BPF expression" "직접 입력 (BPF 식)"; msg tcp_port_p "port: " "포트: "; msg tcp_host_p "host: " "호스트: "; msg tcp_bpf_p "BPF: " "BPF: "
msg tcp_sum "summary: %s packets  SYN %s  SYN-ACK %s  RST %s  FIN %s  unanswered SYN %s" "요약: %s 패킷  SYN %s  SYN-ACK %s  RST %s  FIN %s  응답 없는 SYN %s"
msg probe_fail "could not read /proc in the pod (no shell in the image?)" "파드의 /proc 를 읽지 못함 (이미지에 sh 가 없음?)"
msg ns_h " q/Esc back   r sample now   every %ss" " q/Esc 복귀   r 지금 샘플   %s초마다"; msg dash_h " q/Esc back   r refresh   every %ss" " q/Esc 복귀   r 갱신   %s초마다"
msg k_title "kubectl commands for the selection" "선택 항목에 해당하는 kubectl 명령"
msg help_lang "  (e = English, k = 한국어, any other key returns)" "  (e = English, k = 한국어, 다른 키는 복귀)"
msg ctx_switched "context: %s" "컨텍스트: %s"; msg ns_switched "namespace: %s" "네임스페이스: %s"; msg detail_on "detail bar on" "상세 표시줄 켬"; msg detail_off "detail bar off" "상세 표시줄 끔"
msg local_only "this view reads /proc of this host; the selected node is %s (set PODTREE_SSH to reach other nodes)" "이 화면은 이 호스트의 /proc 를 읽습니다. 선택한 노드는 %s (다른 노드는 PODTREE_SSH 설정)"
msg p_nodes "nodes" "노드"; msg p_usage "usage" "사용률"; msg p_req "requests" "요청량"; msg p_cordon "cordoned" "cordon"; msg p_pods "pods" "파드"
msg p_pend "pending" "대기"; msg p_crash "failing" "오류"; msg p_other "other bad" "기타 비정상"; msg p_rs "restarts" "재시작"
msg p_wl "workloads" "워크로드"; msg p_ok "ok" "정상"; msg p_roll "rolling" "롤아웃 중"; msg p_short "short" "미달"; msg p_na "(cannot list)" "(조회 불가)"
msg p_ev "warnings 10m" "경고 10분"; msg p_ago "%s ago" "%s 전"; msg p_wait "..." "..."
msg panel_on "status panel on" "상태판 켬"; msg panel_off "status panel off" "상태판 끔"
msg p_rs1h "restarted(1h)" "재시작(1h)"; msg p_oom "OOM(1h)" "OOM(1h)"; msg p_pvc "PVC pending" "PVC 대기"; msg p_job "Job failed" "Job 실패"; msg p_hpa "HPA at max" "HPA 최대"
msg p_chg "changes" "변화"; msg p_none "none yet" "아직 없음"
msg h_node "node" "노드"; msg h_new "new" "생성"; msg h_gone "gone" "삭제"; msg h_rs "restart" "재시작"; msg h_fix "resolved" "해결"; msg h_roll "rollout" "롤아웃"
msg h_start "start: %s" "시작: %s"; msg h_title "change history" "변화 기록"; msg h_empty "no changes yet" "아직 변화 없음"
msg h_help " q/Esc back   Space/Enter browse (less)   S save      changes since start, newest at the bottom   [!!] broke  [! ] warning  [ok] recovered" " q/Esc 복귀   Space/Enter 둘러보기(less)   S 저장      시작 후 변화, 아래가 최신   [!!] 고장  [! ] 주의  [ok] 회복"
msg i_title "problems  (Enter: pod/node -> jump in the tree, others -> describe)" "문제 목록  (Enter: 파드·노드는 트리에서 이동, 나머지는 describe)"; msg i_none "no problems found" "문제 없음"
msg i_nrp "not-ready pods" "비정상 파드"; msg i_node "[node]" "[노드]"; msg i_wl "[res]" "[리소스]"; msg i_pod "[pod]" "[파드]"; msg i_rs "[restarted]" "[재시작]"

# ---------------------------------------------------------------- kubectl go-templates (one API call per refresh, no jq)
T='{{"\t"}}'; NL='{{"\n"}}'
CS='{{.name}};{{.ready}};{{.restartCount}};{{.started}};{{if .state.running}}R;;;;{{.state.running.startedAt}}{{else if .state.terminated}}T;{{.state.terminated.reason}};{{.state.terminated.exitCode}};{{.state.terminated.signal}};{{.state.terminated.finishedAt}}{{else if .state.waiting}}W;{{.state.waiting.reason}};;;{{else}}U;;;;{{end}};{{with .lastState.terminated}}{{.reason}};{{.exitCode}};{{.finishedAt}}{{else}};;{{end}}'
POD_ROW="{{.spec.nodeName}}$T{{.metadata.namespace}}$T{{.metadata.name}}$T{{.status.phase}}$T{{.status.reason}}$T{{.metadata.creationTimestamp}}$T{{.metadata.deletionTimestamp}}$T{{.status.podIP}}$T{{.status.hostIP}}$T"
POD_ROW+="{{range .metadata.ownerReferences}}{{.kind}}/{{.name}},{{end}}$T{{range .spec.containers}}{{.name}},{{end}}$T{{range .spec.initContainers}}{{.name}}{{with .restartPolicy}}:{{.}}{{end}},{{end}}$T"
POD_ROW+="{{range .status.conditions}}{{.type}}={{.status}}{{with .reason}}:{{.}}{{end}},{{end}}$T"
POD_ROW+="{{range .status.initContainerStatuses}}$CS|{{end}}$T{{range .status.containerStatuses}}$CS;{{.image}}|{{end}}$T"
POD_ROW+="{{range \$k,\$v := .metadata.labels}}{{\$k}}={{\$v}},{{end}}$T{{range .spec.containers}}{{range .ports}}{{.containerPort}},{{end}}{{end}}$T"
POD_ROW+="{{range .spec.volumes}}{{with .persistentVolumeClaim}}pvc:{{.claimName}},{{end}}{{with .configMap}}cm:{{.name}},{{end}}{{with .secret}}secret:{{.secretName}},{{end}}{{end}}$T"
POD_ROW+="{{.status.qosClass}}$T{{.spec.hostNetwork}}$T{{range .spec.containers}}{{with .resources.requests}}{{.cpu}};{{.memory}}{{else}};{{end}};{{with .resources.limits}}{{.cpu}};{{.memory}}{{else}};{{end}}|{{end}}$T{{.spec.serviceAccountName}}"
# Discovery metadata is appended; the existing pod parser keeps its field indexes.
POD_ROW+="$T{{range .spec.containers}}{{.image}} {{range .command}}{{printf \"%q \" .}}{{end}}{{range .args}}{{printf \"%q \" .}}{{end}}{{end}}"
POD_ROW+="$T{{with .metadata.annotations}}{{with index . \"podtree.io/monitor\"}}{{printf \"%q\" .}}{{end}}$T{{with index . \"podtree.io/metrics-port\"}}{{printf \"%q\" .}}{{end}}$T{{with index . \"podtree.io/metrics-path\"}}{{printf \"%q\" .}}{{end}}$T{{with index . \"prometheus.io/port\"}}{{printf \"%q\" .}}{{end}}$T{{with index . \"prometheus.io/path\"}}{{printf \"%q\" .}}{{end}}{{else}}$T$T$T$T{{end}}$T{{.metadata.uid}}"
POD_TPL="{{range .items}}$POD_ROW$NL{{end}}"
NODE_ROW="{{.metadata.name}}$T{{range .status.conditions}}{{.type}}={{.status}},{{end}}$T{{.spec.unschedulable}}$T{{range \$k,\$v := .metadata.labels}}{{\$k}}={{\$v}},{{end}}$T{{.status.nodeInfo.kubeletVersion}}$T"
NODE_ROW+="{{range .status.addresses}}{{.type}}={{.address}},{{end}}$T{{.spec.podCIDR}}$T{{.status.allocatable.pods}};{{.status.allocatable.cpu}};{{.status.allocatable.memory}}$T{{.status.capacity.pods}};{{.status.capacity.cpu}};{{.status.capacity.memory}}$T"
NODE_ROW+="{{range .spec.taints}}{{.key}}={{.value}}:{{.effect}},{{end}}$T{{.metadata.creationTimestamp}}$T{{.status.nodeInfo.osImage}}$T{{.status.nodeInfo.containerRuntimeVersion}}$T{{.status.nodeInfo.kernelVersion}}"
NODE_ROW+="$T{{range .status.conditions}}{{if eq .type \"Ready\"}}{{.lastTransitionTime}}{{end}}{{end}}"
NODE_TPL="{{range .items}}$NODE_ROW$NL{{end}}"
# status panel: workloads (ready vs desired) and Warning events.  Event messages can hold newlines -> records start with \036
WL_ROW="{{.kind}}$T{{.metadata.namespace}}$T{{.metadata.name}}$T{{if eq .kind \"DaemonSet\"}}{{.status.desiredNumberScheduled}}$T{{.status.numberReady}}$T{{.status.updatedNumberScheduled}}"
WL_ROW+="{{else}}{{.spec.replicas}}$T{{.status.readyReplicas}}$T{{.status.updatedReplicas}}{{end}}$T{{.metadata.generation}}$T{{.status.observedGeneration}}"
WL_TPL="{{range .items}}$WL_ROW$NL{{end}}"
EV_TPL="{{range .items}}"$'\036'"{{.metadata.namespace}}$T{{.involvedObject.kind}}/{{.involvedObject.name}}$T{{.reason}}$T{{.lastTimestamp}}$T{{.eventTime}}$T{{.metadata.creationTimestamp}}$T{{.message}}{{end}}"
# status panel: PVCs not Bound, failed Jobs (newest run of each CronJob), HPAs at their maximum - one call for the three kinds
XR_ROW="{{.kind}}$T{{.metadata.namespace}}$T{{.metadata.name}}$T{{.metadata.creationTimestamp}}$T"
XR_ROW+="{{if eq .kind \"PersistentVolumeClaim\"}}{{.status.phase}}$T{{.spec.storageClassName}}"
XR_ROW+="{{else if eq .kind \"Job\"}}{{.status.failed}}$T{{.status.active}}$T{{.status.succeeded}}$T{{range .status.conditions}}{{.type}}={{.status}}@{{.lastTransitionTime}},{{end}}$T{{range .metadata.ownerReferences}}{{.kind}}/{{.name}}{{end}}"
XR_ROW+="{{else}}{{.spec.scaleTargetRef.kind}}/{{.spec.scaleTargetRef.name}}$T{{.spec.maxReplicas}}$T{{.status.currentReplicas}}$T{{.status.desiredReplicas}}{{end}}"
XR_TPL="{{range .items}}$XR_ROW$NL{{end}}"
# relations: services / endpoints / pvc (core) and ingress / networkpolicy (networking) - fetched on demand
REL_CORE="{{range .items}}{{.kind}}$T{{.metadata.name}}$T{{if eq .kind \"Service\"}}{{.spec.type}}$T{{.spec.clusterIP}}$T{{range .spec.ports}}{{.port}}:{{.targetPort}}/{{.protocol}}{{with .nodePort}}:np{{.}}{{end}},{{end}}$T{{range \$k,\$v := .spec.selector}}{{\$k}}={{\$v}},{{end}}$T{{range .status.loadBalancer.ingress}}{{.ip}}{{.hostname}},{{end}}"
REL_CORE+="{{else if eq .kind \"Endpoints\"}}{{range .subsets}}{{range .addresses}}{{.ip}}={{with .targetRef}}{{.name}}{{end}},{{end}}{{end}}$T{{range .subsets}}{{range .notReadyAddresses}}{{.ip}}={{with .targetRef}}{{.name}}{{end}},{{end}}{{end}}"
REL_CORE+="{{else if eq .kind \"PersistentVolumeClaim\"}}{{.status.phase}}$T{{.spec.volumeName}}$T{{.status.capacity.storage}}$T{{.spec.storageClassName}}$T{{range .spec.accessModes}}{{.}},{{end}}{{end}}$NL{{end}}"
REL_NET="{{range .items}}{{.kind}}$T{{.metadata.name}}$T{{if eq .kind \"Ingress\"}}{{.spec.ingressClassName}}$T{{range .spec.rules}}{{.host}}[{{range .http.paths}}{{.path}}>{{.backend.service.name}}:{{.backend.service.port.number}}{{.backend.service.port.name}},{{end}}];{{end}}$T{{range .status.loadBalancer.ingress}}{{.ip}}{{.hostname}},{{end}}$T{{with .spec.defaultBackend}}{{.service.name}}{{end}}"
REL_NET+="{{else if eq .kind \"NetworkPolicy\"}}{{range \$k,\$v := .spec.podSelector.matchLabels}}{{\$k}}={{\$v}},{{end}}$T{{range .spec.podSelector.matchExpressions}}{{.key}} {{.operator}},{{end}}$T{{range .spec.policyTypes}}{{.}},{{end}}$T{{range .spec.ingress}}i{{end}}$T{{range .spec.egress}}e{{end}}{{end}}$NL{{end}}"

# awk: template rows -> tree rows, READY / STATUS / RESTARTS / AGE computed exactly like kubectl's printer (printers.go)
cat >"$TMP/time.awk" <<'EOF'
function epoch(ts,   y, m, d, H, M, S, era, yoe, doy, doe, days) {
    if (ts !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T/) return 0
    y = substr(ts, 1, 4) + 0; m = substr(ts, 6, 2) + 0; d = substr(ts, 9, 2) + 0
    H = substr(ts, 12, 2) + 0; M = substr(ts, 15, 2) + 0; S = substr(ts, 18, 2) + 0
    if (m <= 2) y--
    era = int((y >= 0 ? y : y - 399) / 400); yoe = y - era * 400
    doy = int((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1
    doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
    days = era * 146097 + doe - 719468
    return days * 86400 + H * 3600 + M * 60 + S
}
function human(s,   m, h, x) {
    if (s < 0) return "0s"
    if (s < 120) return s "s"
    m = int(s / 60)
    if (m < 10) { x = s % 60; return (x == 0) ? m "m" : m "m" x "s" }
    if (m < 180) return m "m"
    h = int(s / 3600)
    if (h < 8) { x = m % 60; return (x == 0) ? h "h" : h "h" x "m" }
    if (h < 48) return h "h"
    if (h < 24 * 8) { x = h % 24; return (x == 0) ? int(h / 24) "d" : int(h / 24) "d" x "h" }
    if (h < 24 * 365 * 2) return int(h / 24) "d"
    if (h < 24 * 365 * 8) { x = int(h / 24) % 365; return (x == 0) ? int(h / 24 / 365) "y" : int(h / 24 / 365) "y" x "d" }
    return int(h / 24 / 365) "y"
}
EOF
cat >"$TMP/pods.awk" <<'EOF'
BEGIN { FS = "\t"; OFS = "\037" }
function ago(ts,   e) { e = epoch(ts); return (e > 0) ? human(now - e) : "" }
{
    gsub(/<no value>/, "")
    node = $1; ns = $2; name = $3; phase = $4; preason = $5; created = $6; deleting = $7; ip = $8; hip = $9
    owners = $10; cnames = $11; inames = $12; conds = $13; ists = $14; csts = $15
    labels = $16; ports = $17; vols = $18; qos = $19; hostnet = $20; res = $21; sa = $22
    if (node == "") node = "~"
    total = split(cnames, tmp, ","); if (cnames == "") total = 0; else total--
    ninit = split(inames, initarr, ","); if (inames == "") ninit = 0; else ninit--
    delete restartable
    for (i = 1; i <= ninit; i++) { split(initarr[i], kv, ":"); if (kv[2] == "Always") { restartable[kv[1]] = 1; total++ } }
    reason = phase; if (preason != "") reason = preason
    initialized = 0; readycond = 0
    n = split(conds, carr, ",")
    for (i = 1; i <= n; i++) {
        if (carr[i] == "PodScheduled=False:SchedulingGated") reason = "SchedulingGated"
        if (carr[i] == "Initialized=True") initialized = 1
        if (carr[i] == "Ready=True") readycond = 1
    }
    restarts = 0; rinit = 0; lastr = 0; lastri = 0; readyc = 0; initializing = 0
    n = split(ists, sarr, "|"); if (ists == "") n = 0; else n--
    for (i = 1; i <= n; i++) {
        split(sarr[i], f, ";")
        restarts += f[3]
        if (f[10] != "" || f[11] != "") { e = epoch(f[12]); if (e > lastr) lastr = e }
        if (f[1] in restartable) { rinit += f[3]; if (f[10] != "" || f[11] != "") { e = epoch(f[12]); if (e > lastri) lastri = e } }
        if (f[5] == "T" && f[7] == 0) continue
        if ((f[1] in restartable) && f[4] == "true") { if (f[2] == "true") readyc++; continue }
        if (f[5] == "T") {
            if (f[6] == "") reason = (f[8] != "" && f[8] != 0) ? "Init:Signal:" f[8] : "Init:ExitCode:" f[7]
            else reason = "Init:" f[6]
            initializing = 1
        } else if (f[5] == "W" && f[6] != "" && f[6] != "PodInitializing") { reason = "Init:" f[6]; initializing = 1 }
        else { reason = "Init:" (i - 1) "/" ninit; initializing = 1 }
        break
    }
    n = split(csts, sarr, "|"); if (csts == "") n = 0; else n--
    if (!initializing || initialized) {
        restarts = rinit; lastr = lastri; hasrun = 0
        for (i = n; i >= 1; i--) {
            split(sarr[i], f, ";")
            restarts += f[3]
            if (f[10] != "" || f[11] != "") { e = epoch(f[12]); if (e > lastr) lastr = e }
            if (f[5] == "W" && f[6] != "") reason = f[6]
            else if (f[5] == "T" && f[6] != "") reason = f[6]
            else if (f[5] == "T") reason = (f[8] != "" && f[8] != 0) ? "Signal:" f[8] : "ExitCode:" f[7]
            else if (f[2] == "true" && f[5] == "R") { hasrun = 1; readyc++ }
        }
        if (reason == "Completed" && hasrun) reason = readycond ? "Running" : "NotReady"
    }
    if (deleting != "" && preason == "NodeLost") reason = "Unknown"
    else if (deleting != "" && phase != "Failed" && phase != "Succeeded") reason = "Terminating"
    csum = ""; oom = 0     # oom: containers OOMKilled in the last hour (now or as their last termination)
    for (i = 1; i <= n; i++) {
        split(sarr[i], f, ";")
        st = (f[5] == "R") ? "Running" : (f[5] == "W") ? "Waiting" : (f[5] == "T") ? "Terminated" : "Unknown"
        csum = csum f[1] ";" st ";" f[6] ";" f[7] ";" f[3] ";" f[2] ";" f[10] ";" f[11] ";" ago(f[12]) ";" f[13] "|"
        if ((f[10] == "OOMKilled" && now - epoch(f[12]) <= 3600) || (f[5] == "T" && f[6] == "OOMKilled" && now - epoch(f[9]) <= 3600)) oom++
    }
    isum = ""
    n = split(ists, sarr, "|"); if (ists == "") n = 0; else n--
    for (i = 1; i <= n; i++) {
        split(sarr[i], f, ";")
        st = (f[5] == "R") ? "Running" : (f[5] == "W") ? "Waiting" : (f[5] == "T") ? "Terminated" : "Unknown"
        isum = isum f[1] ";" st ";" f[6] ";" f[7] ";" f[3] ";" f[2] ";" f[10] ";" f[11] ";" ago(f[12]) ";init|"
    }
    bad = 1
    if (reason == "Completed" || reason == "Succeeded") bad = 0
    else if (reason == "Running" && readyc == total) bad = 0
    owner = owners; sub(/,.*/, "", owner)
    wl = owner
    if (owner ~ /^ReplicaSet\//) { sub(/^ReplicaSet\//, "Deployment/", wl); sub(/-[a-z0-9]+$/, "", wl) }
    else if (owner ~ /^Job\/.*-[0-9]+$/) { sub(/^Job\//, "CronJob/", wl); sub(/-[0-9]+$/, "", wl) }
    else if (owner == "") wl = "Pod/" name
    ce = epoch(created); age = (ce > 0) ? human(now - ce) : ""; ages = (ce > 0) ? now - ce : 0
    print node, ns, name, readyc "/" total, reason, restarts, (restarts > 0 && lastr > 0) ? human(now - lastr) : "", age, bad,
          ip, hip, owner, wl, isum csum, labels, ports, vols, qos, hostnet, res, ages, cnames, inames, sa, conds, (restarts > 0 && lastr > 0) ? now - lastr : "", oom
}
EOF
cat >"$TMP/nodes.awk" <<'EOF'
BEGIN { FS = "\t"; OFS = "\037" }
{
    gsub(/<no value>/, "")
    ready = "Unknown"; press = ""
    n = split($2, c, ",")
    for (i = 1; i <= n; i++) {
        if (c[i] == "Ready=True") ready = "Ready"; else if (c[i] == "Ready=False") ready = "NotReady"
        if (c[i] ~ /^(MemoryPressure|DiskPressure|PIDPressure|NetworkUnavailable)=True$/) { sub(/=True$/, "", c[i]); press = press c[i] "," }
    }
    st = ready; if ($3 == "true") st = st ",SchedulingDisabled"
    roles = ""; n = split($4, l, ",")
    for (i = 1; i <= n; i++) if (l[i] ~ /^node-role\.kubernetes\.io\//) { r = l[i]; sub(/^node-role\.kubernetes\.io\//, "", r); sub(/=.*/, "", r); roles = roles r "," }
    sub(/,$/, "", roles); sub(/,$/, "", press)
    rt = epoch($15); print $1, st, roles, $5, $6, $7, $8, $9, press, $10, $12, $13, $14, $11, (rt > 0 ? now - rt : "")
}
EOF
# status panel: workloads -> kind ns name desired ready updated state(ok | roll | short)
cat >"$TMP/wl.awk" <<'EOF'
BEGIN { FS = "\t"; OFS = "\037" }
{
    gsub(/<no value>/, "")
    k = $1
    if (k == "Deployment") k = "deploy"; else if (k == "StatefulSet") k = "sts"; else if (k == "DaemonSet") k = "ds"; else next
    want = $4 + 0; rdy = $5 + 0; upd = $6 + 0; gen = $7 + 0; ogen = $8 + 0
    if (k != "ds" && $4 == "") want = 1
    st = "ok"
    if (upd < want || (ogen > 0 && ogen < gen)) st = "roll"
    else if (rdy < want) st = "short"
    print k, $2, $3, want, rdy, upd, st
}
EOF
# status panel: Warning events -> one line: count in the last 10 min, top reasons, newest event (age ns/object reason message)
cat >"$TMP/ev.awk" <<'EOF'
BEGIN { RS = "\036"; FS = "\t"; win = 600 }
NF >= 7 {
    gsub(/<no value>/, "")
    ts = $4; if (ts == "") ts = $5; if (ts == "") ts = $6
    e = epoch(ts)
    if (e > 0 && now - e <= win) { n++; R[$3]++ }
    if (e > newest) {
        newest = e; m = $7; for (i = 8; i <= NF; i++) m = m " " $i
        gsub(/[\r\n\t]+/, " ", m); gsub(/\037/, " ", m)
        no = ($1 == "" ? "" : $1 "/") $2; nr = $3; nm = m
    }
}
END {
    top = ""
    for (k = 0; k < 3; k++) { best = ""; bv = 0; for (r in R) if (R[r] > bv) { bv = R[r]; best = r }; if (best == "") break; top = top (top == "" ? "" : ", ") best " " bv; delete R[best] }
    printf "%d\037%s\037%s\037%s\037%s\037%s\n", n, top, (newest > 0 ? human(now - newest) : ""), no, nr, substr(nm, 1, 400)
}
EOF
# status panel: per node  requests (cpu millicores / memory bytes) of the pods still holding resources, vs allocatable
cat >"$TMP/nodestat.awk" <<'EOF'
BEGIN {
    FS = "\037"
    U["Ki"] = 1024; U["Mi"] = 1048576; U["Gi"] = 1073741824; U["Ti"] = 1099511627776; U["Pi"] = 1125899906842624
    U["k"] = 1000; U["K"] = 1000; U["M"] = 1e6; U["G"] = 1e9; U["T"] = 1e12; U["P"] = 1e15; U["m"] = 0.001
}
function cpu(q) {
    if (q == "") return 0
    if (q ~ /m$/) return substr(q, 1, length(q) - 1) + 0
    if (q ~ /u$/) return substr(q, 1, length(q) - 1) / 1000
    if (q ~ /n$/) return substr(q, 1, length(q) - 1) / 1000000
    return q * 1000
}
function mem(q,   u) {
    if (q == "") return 0
    if (match(q, /[A-Za-z]+$/)) { u = substr(q, RSTART); return substr(q, 1, RSTART - 1) * ((u in U) ? U[u] : 1) }
    return q + 0
}
FILENAME == nf { split($7, a, ";"); AC[$1] = cpu(a[2]); AM[$1] = mem(a[3]); N[$1] = 1; next }
{
    if ($1 == "~" || $5 ~ /^(Completed|Succeeded|Failed|Evicted|Error)$/) next
    n = split($20, c, "|")
    for (i = 1; i <= n; i++) { if (c[i] == "") continue; split(c[i], f, ";"); RC[$1] += cpu(f[1]); RM[$1] += mem(f[2]) }
}
END { for (k in N) printf "%s\037%d\037%d\n", k, (AC[k] > 0 ? RC[k] * 100 / AC[k] : -1), (AM[k] > 0 ? RM[k] * 100 / AM[k] : -1) }
EOF
# status panel: pvc / job / hpa problems -> kind ns/name what(one word) severity(short | roll)
cat >"$TMP/xr.awk" <<'EOF'
BEGIN { FS = "\t"; OFS = "\037" }
{
    gsub(/<no value>/, "")
    key = $2 "/" $3
    if ($1 == "PersistentVolumeClaim") { if ($5 != "Bound") print "pvc", key, ($5 == "" ? "Pending" : $5), "short"; next }
    if ($1 == "Job") {
        failed = 0; ft = 0; n = split($8, c, ",")
        for (i = 1; i <= n; i++) if (c[i] ~ /^Failed=True@/) { failed = 1; ft = epoch(substr(c[i], 13)) }
        if ($9 ~ /^CronJob\//) {          # only the newest run of a CronJob counts: a later success clears an old failure
            o = $2 "/" $9; ce = epoch($4)
            if (!(o in LATEST) || ce >= LATEST[o]) { LATEST[o] = ce; LJ[o] = key; LF[o] = failed; LA[o] = ($5 > 0 && $6 > 0) ? $5 : 0 }
            next
        }
        if (failed && now - ft <= 86400) print "job", key, "failed" ($5 > 0 ? ":" $5 : ""), "short"
        else if ($5 > 0 && $6 > 0) print "job", key, "retrying:" $5, "roll"
        next
    }
    if ($1 == "HorizontalPodAutoscaler") { if ($6 > 0 && $7 + 0 >= $6 + 0) print "hpa", key, "at-max:" $7 "/" $6, "roll"; next }
}
END {
    for (o in LATEST) {
        if (LF[o]) print "job", LJ[o], "failed(" substr(o, index(o, "/") + 1) ")", "short"
        else if (LA[o]) print "job", LJ[o], "retrying:" LA[o], "roll"
    }
}
EOF
# log colorizer: level words, timestamps, [pod prefix] per-pod colors (stream stage only; less shows the raw file)
cat >"$TMP/color.awk" <<'EOF'
function hash(s,   i, h) { h = 0; for (i = 1; i <= length(s); i++) h = (h * 31 + index("abcdefghijklmnopqrstuvwxyz0123456789-/.", substr(s, i, 1))) % 6; return h }
BEGIN {
    pc[0] = "36"; pc[1] = "35"; pc[2] = "34"; pc[3] = "32"; pc[4] = "33"; pc[5] = "96"
    n = split(pfx, pa, ","); for (i = 1; i <= n; i++) if (pa[i] != "") { split(pa[i], kv, "="); NSMAP[kv[1]] = kv[2] }
}
{
    line = $0; pre = ""
    if (mode == "logs" && match(line, /^\[[^]]*\] /)) {
        pre = substr(line, 1, RLENGTH); line = substr(line, RLENGTH + 1)
        if (pre ~ /^\[pod\//) { nm = substr(pre, 6); sub(/\/.*/, "", nm); if (nm in NSMAP) sub(/^\[pod\//, "[" NSMAP[nm] "/", pre) }
        pre = "\033[" pc[hash(pre)] "m" pre "\033[0m"
    }
    if (mode == "tcpdump") {
        if (line ~ /\[S\]/) line = "\033[32m" line "\033[0m"
        else if (line ~ /\[S\.\]/) line = "\033[36m" line "\033[0m"
        else if (line ~ /\[R\.?\]/) line = "\033[1;31m" line "\033[0m"
        else if (line ~ /\[F\.?\]/) line = "\033[33m" line "\033[0m"
    } else if (mode == "netstat") {
        if (line ~ /^\[!!\]/) line = "\033[1;31m" line "\033[0m"
        else if (line ~ /^\[!\]/) line = "\033[33m" line "\033[0m"
        else if (line ~ /^----/) line = "\033[2m" line "\033[0m"
        else if (line ~ /^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/) line = "\033[2m" substr(line, 1, 8) "\033[22m" substr(line, 9)
    } else if (line ~ /(^|[^A-Za-z])(ERROR|ERR|FATAL|CRIT|CRITICAL|PANIC|SEVERE|EMERG|ALERT)([^A-Za-z]|$)|"level":"(error|fatal)"|level=(error|fatal)|(^|[^A-Za-z])E[0-9][0-9][0-9][0-9] |Traceback|Exception|panic:/) line = "\033[1;31m" line "\033[0m"
    else if (line ~ /(^|[^A-Za-z])(WARN|WARNING|Warning)([^A-Za-z]|$)|(^|[^A-Za-z])W[0-9][0-9][0-9][0-9] |"level":"warn(ing)?"|level=warn(ing)?/) line = "\033[33m" line "\033[0m"
    else if (line ~ /(^|[^A-Za-z])(DEBUG|TRACE|DBG)([^A-Za-z]|$)|"level":"(debug|trace)"|level=(debug|trace)/) line = "\033[2m" line "\033[0m"
    else if (match(line, /(^|[^A-Za-z])(INFO|I[0-9][0-9][0-9][0-9])([^A-Za-z]|$)/)) line = substr(line, 1, RSTART - 1) "\033[32m" substr(line, RSTART, RLENGTH) "\033[0m" substr(line, RSTART + RLENGTH)
    if (mode != "tcpdump" && match(line, /^(\033\[[0-9;]*m)?[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]:[0-9][0-9](\.[0-9]+)?Z?/)) {
        line = "\033[2m" substr(line, 1, RLENGTH) "\033[22m" substr(line, RLENGTH + 1)
    }
    print pre line; fflush()
}
EOF
# tcpdump summary over the raw capture: packets, SYN, SYN-ACK, RST, FIN, SYNs that never got a SYN-ACK
cat >"$TMP/tcpsum.awk" <<'EOF'
{
    n++
    if ($0 ~ /Flags \[S\]/) { syn++; if (match($0, /IP6? [^ ]+ > [^ ]+:/)) { k = substr($0, RSTART, RLENGTH); sub(/^IP6? /, "", k); sub(/:$/, "", k); split(k, ab, " > "); want[ab[1] " " ab[2]] = 1 } }
    else if ($0 ~ /Flags \[S\.\]/) { synack++; if (match($0, /IP6? [^ ]+ > [^ ]+:/)) { k = substr($0, RSTART, RLENGTH); sub(/^IP6? /, "", k); sub(/:$/, "", k); split(k, ab, " > "); delete want[ab[2] " " ab[1]] } }
    else if ($0 ~ /Flags \[R/) rst++
    else if ($0 ~ /Flags \[F/) fin++
}
END { u = 0; for (k in want) u++; printf "%d\t%d\t%d\t%d\t%d\t%d\n", n, syn, synack, rst, fin, u }
EOF

# ---------------------------------------------------------------- data
fetch_job() {   # background: pods (+nodes, +top, +status panel data) -> $TMP/*.new ; writes $TMP/fetch.done with the kubectl rc
    local rc nsa=(--all-namespaces) evt=0 tft=0 bg=()
    now_epoch
    [[ -n $NS ]] && nsa=(-n "$NS")
    kc get pods "${nsa[@]}" -o go-template="$POD_TPL" >"$TMP/pods.tpl" 2>"$TMP/err"; rc=$?
    if ((rc == 0)); then
        if ((PANEL || IN_DASH)); then     # independent API calls, run beside the pod / node processing
            kc get deployments,statefulsets,daemonsets "${nsa[@]}" -o go-template="$WL_TPL" >"$TMP/wl.raw" 2>/dev/null \
                && awk -f "$TMP/wl.awk" "$TMP/wl.raw" >"$TMP/wl.tmp" || echo '!' >"$TMP/wl.tmp" &
            bg+=($!)
            kc get persistentvolumeclaims,jobs,horizontalpodautoscalers "${nsa[@]}" -o go-template="$XR_TPL" 2>/dev/null \
                | awk -v now="$NOW" -f "$TMP/time.awk" -f "$TMP/xr.awk" >"$TMP/xr.tmp" &
            bg+=($!)
            [[ -r $TMP/ev.stamp ]] && evt=$(<"$TMP/ev.stamp")
            if ((NOW - evt >= 15)); then  # events are the biggest list: every 15s at most
                echo "$NOW" >"$TMP/ev.stamp"
                kc get events "${nsa[@]}" --field-selector type=Warning -o go-template="$EV_TPL" 2>/dev/null \
                    | awk -v now="$NOW" -f "$TMP/time.awk" -f "$TMP/ev.awk" >"$TMP/ev.tmp" &
                bg+=($!)
            fi
        fi
        awk -v now="$NOW" -f "$TMP/time.awk" -f "$TMP/pods.awk" "$TMP/pods.tpl" >"$TMP/pods.new"
        kc get nodes -o go-template="$NODE_TPL" 2>/dev/null | awk -v now="$NOW" -f "$TMP/time.awk" -f "$TMP/nodes.awk" >"$TMP/nodes.new"
        if ((TOPON)); then
            if [[ -n $NS ]]; then kc top pods -n "$NS" --no-headers 2>/dev/null | awk -v ns="$NS" '{ print ns "/" $1 "\037" $2 "\037" $3 }' >"$TMP/top.new"
            else kc top pods -A --no-headers 2>/dev/null | awk '{ print $1 "/" $2 "\037" $3 "\037" $4 }' >"$TMP/top.new"; fi
        fi
        if ((TOPON || PANEL || IN_DASH)); then
            [[ -r $TMP/topn.fail ]] && tft=$(<"$TMP/topn.fail")
            if ((TOPON || NOW - tft >= 60)); then   # no metrics-server: the panel retries once a minute only
                kc top nodes --no-headers 2>/dev/null | awk '$2 != "<unknown>" { print $1 "\037" $2 "\037" $3 "\037" $4 "\037" $5 }' >"$TMP/topn.new"
                if [[ -s $TMP/topn.new ]]; then rm -f "$TMP/topn.fail"; else echo "$NOW" >"$TMP/topn.fail"; fi
            fi
        fi
        if ((PANEL || IN_DASH)); then
            awk -v nf="$TMP/nodes.new" -f "$TMP/nodestat.awk" "$TMP/nodes.new" "$TMP/pods.new" >"$TMP/nstat.new"
            ((${#bg[@]})) && wait "${bg[@]}"
            [[ -e $TMP/wl.tmp ]] && mv -f "$TMP/wl.tmp" "$TMP/wl.new"
            [[ -e $TMP/ev.tmp ]] && mv -f "$TMP/ev.tmp" "$TMP/ev.new"
            [[ -e $TMP/xr.tmp ]] && mv -f "$TMP/xr.tmp" "$TMP/xr.new"
        fi
    fi
    echo "$rc" >"$TMP/fetch.done"
}
start_fetch() {
    [[ -n $FETCH_PID ]] && return
    rm -f "$TMP/fetch.done"
    fetch_job </dev/null &     # never let kubectl (or an auth plugin) read keys meant for the UI
    FETCH_PID=$!
    now_epoch; LAST_FETCH=$NOW
}
check_fetch() {   # every tick; returns 0 when the background fetch finished (data loaded or error shown)
    [[ -n $FETCH_PID && -e $TMP/fetch.done ]] || return 1
    wait "$FETCH_PID" 2>/dev/null; FETCH_PID=""
    local rc; rc=$(<"$TMP/fetch.done")
    if [[ $rc != 0 ]]; then
        ERR=$(head -n 1 "$TMP/err"); ERR=${ERR:-"kubectl exited $rc"}
        t kfail; printf -v MSG "$S" "$ERR"; LOADED=1
        return 0
    fi
    ERR=""
    t refreshing; [[ $MSG == "$S" ]] && MSG=""
    t kfail; [[ $MSG == "${S%%:*}"* ]] && MSG=""
    mv -f "$TMP/pods.new" "$TMP/pods.tsv"; mv -f "$TMP/nodes.new" "$TMP/nodes.tsv"
    cp "$TMP/pods.tpl" "$TMP/pods.snapshot"
    ((TOPON)) && mv -f "$TMP/top.new" "$TMP/top.tsv" 2>/dev/null
    local f; for f in topn nstat wl ev xr; do [[ -e $TMP/$f.new ]] && mv -f "$TMP/$f.new" "$TMP/$f.tsv"; done
    printf -v LAST_REFRESH '%(%H:%M:%S)T' -1 2>/dev/null || LAST_REFRESH=$(date +%H:%M:%S)
    NEWDATA=1; load
    return 0
}
fetch_sync() { fetch_job </dev/null; FETCH_PID=$$; check_fetch; }   # blocking (first load, forced refresh)

sort_keys() {   # SORTK[] for sort(1): grouping columns first, then the chosen order
    local g=() s=()
    case $GROUP in node,ns) g=(-k1,1 -k2,2) ;; ns) g=(-k2,2) ;; ns,wl) g=(-k2,2 -k13,13) ;; node) g=(-k1,1) ;; esac
    case $SORT in name) s=(-k3,3) ;; restarts) s=(-k6,6nr -k3,3) ;; age) s=(-k21,21n -k3,3) ;; status) s=(-k9,9nr -k5,5 -k3,3) ;; esac
    SORTK=("${g[@]}" "${s[@]}")
}
load() {
    local node ns name ready status restarts rago age bad ip hip owner wl ctr labels ports vols qos hn res ages cn inn sa conds rsec oomr key sig nbad=0
    sort_keys
    P_NODE=() P_NS=() P_NAME=() P_READY=() P_STATUS=() P_RESTARTS=() P_RAGO=() P_AGE=() P_BAD=() P_IP=() P_HIP=() P_OWNER=() P_WL=()
    P_CTR=() P_LABELS=() P_PORTS=() P_VOLS=() P_QOS=() P_HOSTNET=() P_RES=() P_AGES=() P_CNAMES=() P_INAMES=() P_SA=() P_CONDS=() P_RSEC=() P_OOM=()
    CHG=(); NEWP=(); NODE_NP=(); NODE_NB=(); NODE_RR=(); ST_RUN=0 ST_PEND=0 ST_CRASH=0 ST_OTHER=0 RS_GROW=0 RS_TOPK="" ST_RREC=0 ST_OOM=0
    local g gmax=0
    local -A seen=()
    while IFS=$'\037' read -r node ns name ready status restarts rago age bad ip hip owner wl ctr labels ports vols qos hn res ages cn inn sa conds rsec oomr; do
        P_NODE+=("$node"); P_NS+=("$ns"); P_NAME+=("$name"); P_READY+=("$ready"); P_STATUS+=("$status"); P_RESTARTS+=("$restarts")
        P_RAGO+=("$rago"); P_AGE+=("$age"); P_BAD+=("$bad"); P_IP+=("$ip"); P_HIP+=("$hip"); P_OWNER+=("$owner"); P_WL+=("$wl")
        P_CTR+=("$ctr"); P_LABELS+=("$labels"); P_PORTS+=("$ports"); P_VOLS+=("$vols"); P_QOS+=("$qos"); P_HOSTNET+=("$hn"); P_RES+=("$res")
        P_AGES+=("$ages"); P_CNAMES+=("$cn"); P_INAMES+=("$inn"); P_SA+=("$sa"); P_CONDS+=("$conds"); P_RSEC+=("$rsec"); P_OOM+=("${oomr:-0}")
        key="$ns/$name"; sig="$ready|$status|$restarts"; seen[$key]=1
        if [[ -n ${PREV_SIG[$key]+x} ]]; then [[ ${PREV_SIG[$key]} != "$sig" ]] && CHG[$key]=1
        else ((FIRST_LOAD)) || NEWP[$key]=1; BASE_RS[$key]=$restarts; fi
        PREV_SIG[$key]=$sig
        ((nbad += bad))
        NODE_NP[$node]=$(( ${NODE_NP[$node]:-0} + 1 )); NODE_NB[$node]=$(( ${NODE_NB[$node]:-0} + bad ))
        if ((bad == 0)); then [[ $status == Running ]] && ((ST_RUN++))
        else case $status in
                Pending|ContainerCreating|PodInitializing|Init:[0-9]*) ((ST_PEND++)) ;;
                *BackOff*|*Err*|*OOM*|*ExitCode*|*Signal*|*Fail*|*Evict*) ((ST_CRASH++)) ;;
                *) ((ST_OTHER++)) ;;
             esac
        fi
        if [[ -n $rsec ]] && ((rsec <= 3600)); then ((ST_RREC++)); NODE_RR[$node]=$(( ${NODE_RR[$node]:-0} + 1 )); fi
        ((ST_OOM += ${oomr:-0}))
        g=$((restarts - ${BASE_RS[$key]:-$restarts}))
        ((g > 0)) && { ((RS_GROW += g)); ((g > gmax)) && { gmax=$g; RS_TOPK=$key; }; }
    done < <(LC_ALL=C sort -t $'\037' "${SORTK[@]}" "$TMP/pods.tsv")
    for key in "${!PREV_SIG[@]}"; do [[ -n ${seen[$key]+x} ]] || unset "PREV_SIG[$key]" "BASE_RS[$key]" "MARK[$key]"; done
    NPODS=${#P_NAME[@]}
    ((BELL)) && ((!FIRST_LOAD)) && ((nbad > BADCOUNT)) && printf '\a'
    BADCOUNT=$nbad; FIRST_LOAD=0; LOADED=1
    NODEINFO=() NODE_ADDR=() NODE_COND=() NODE_ALLOC=() NODE_TAINT=() NODE_VER=() NODE_ROLE=() NODE_MISC=() NODE_CIDR=() NODE_RSINCE=()
    local st roles ver addr cidr alloc cap press taints os rt kern created rsince
    while IFS=$'\037' read -r node st roles ver addr cidr alloc cap press taints os rt kern created rsince; do
        [[ -n $node ]] || continue
        NODEINFO[$node]="$st  ${roles:+$roles  }$ver${press:+  $press}"
        NODE_ADDR[$node]=$addr; NODE_COND[$node]=$press; NODE_ALLOC[$node]=$alloc; NODE_CAP[$node]=$cap; NODE_TAINT[$node]=$taints
        NODE_VER[$node]=$ver; NODE_ROLE[$node]=$roles; NODE_CIDR[$node]=$cidr; NODE_MISC[$node]="$os;$rt;$kern;$created"; NODE_RSINCE[$node]=$rsince
    done <"$TMP/nodes.tsv"
    local c m cp mp
    if ((TOPON)); then
        TOP_CPU=() TOP_MEM=()
        [[ -s $TMP/top.tsv ]] && while IFS=$'\037' read -r key c m; do TOP_CPU[$key]=$c; TOP_MEM[$key]=$m; done <"$TMP/top.tsv"
        [[ -s $TMP/top.tsv ]] || { t top_fail; MSG=$S; }
    fi
    TOPN_CPU=() TOPN_MEM=()
    ((TOPON || PANEL || IN_DASH)) && [[ -s $TMP/topn.tsv ]] && while IFS=$'\037' read -r node c cp m mp; do TOPN_CPU[$node]="$c $cp"; TOPN_MEM[$node]="$m $mp"; done <"$TMP/topn.tsv"
    load_panel
    ((NEWDATA)) && hist_diff
    NEWDATA=0
    build_rows
}
load_panel() {   # status panel data: node order + requests, workloads, pvc / job / hpa, warning events (files written by fetch_job)
    local node c m k ns name want rdy upd st bad=() roll=() what sev
    NODE_RQC=() NODE_RQM=()
    [[ -s $TMP/nstat.tsv ]] && while IFS=$'\037' read -r node c m; do NODE_RQC[$node]=$c; NODE_RQM[$node]=$m; done <"$TMP/nstat.tsv"
    NODE_ORDER=()     # problem nodes first (NotReady, pressure, cordoned, not-ready pods), then by name
    while IFS=$'\037' read -r k node; do NODE_ORDER+=("$node"); done < <(
        for node in "${!NODEINFO[@]}"; do
            k=9; [[ ${NODEINFO[$node]} == *SchedulingDisabled* || ${NODE_NB[$node]:-0} -gt 0 || ${NODE_RR[$node]:-0} -gt 0 ]] && k=5
            [[ ${NODEINFO[$node]} != Ready* || -n ${NODE_COND[$node]} ]] && k=1
            printf '%s\037%s\n' "$k" "$node"
        done | LC_ALL=C sort -t $'\037' -k1,1n -k2,2)
    if [[ -e $TMP/wl.tsv ]]; then
        WL_HAVE=1 WL_FAIL=0 WL_TOTAL=0 WL_OK=0 WL_ROLL=0 WL_SHORT=0 WLS=()
        while IFS=$'\037' read -r k ns name want rdy upd st; do
            [[ $k == '!' ]] && { WL_FAIL=1; break; }
            [[ -n $name ]] || continue
            ((WL_TOTAL++)); WLS["$k $ns/$name"]="$st $rdy/$want"
            case $st in
                ok) ((WL_OK++)) ;;
                roll) ((WL_ROLL++)); roll+=("roll $k $ns/$name $rdy/$want") ;;
                *) ((WL_SHORT++)); bad+=("short $k $ns/$name $rdy/$want") ;;
            esac
        done <"$TMP/wl.tsv"
    fi
    if [[ -e $TMP/xr.tsv ]]; then
        XR_PVC=0 XR_JOB=0 XR_HPA=0 XRS=()
        while IFS=$'\037' read -r k name what sev; do
            [[ -n $name ]] || continue
            XRS["$k $name"]="$what $sev"
            case $k in pvc) ((XR_PVC++)) ;; job) [[ $sev == short ]] && ((XR_JOB++)) ;; hpa) ((XR_HPA++)) ;; esac
            if [[ $sev == short ]]; then bad+=("short $k $name $what"); else roll+=("roll $k $name $what"); fi
        done <"$TMP/xr.tsv"
    fi
    WL_ITEMS=("${bad[@]}" "${roll[@]}")
    if [[ -e $TMP/ev.tsv ]]; then
        EV_HAVE=1
        IFS=$'\037' read -r EV_N EV_TOP EV_AGE EV_OBJ EV_REASON EV_MSG <"$TMP/ev.tsv"
        EV_N=${EV_N:-0}
    fi
}

# ---------------------------------------------------------------- change history (H): what changed between refreshes, since start
hum() {   # hum VAR SECONDS -> 45s / 12m / 5h / 3d
    local s=${2:-0}
    if ((s < 120)); then printf -v "$1" '%ss' "$s"; elif ((s < 7200)); then printf -v "$1" '%sm' $((s / 60))
    elif ((s < 172800)); then printf -v "$1" '%sh' $((s / 3600)); else printf -v "$1" '%sd' $((s / 86400)); fi
}
last_term() {   # last_term POD-INDEX -> LT = "OOMKilled/137" style reason of the most recent container termination (or "")
    local c f parts=()
    LT=""
    IFS='|' read -ra parts <<<"${P_CTR[$1]}"
    for c in "${parts[@]}"; do
        IFS=';' read -r f1 f2 f3 f4 f5 f6 f7 f8 f9 f10 <<<"$c"
        [[ $f2 == Terminated && -n $f3 ]] && { LT="$f3/$f4"; return; }
        [[ -n $f7 && -z $LT ]] && LT="$f7${f8:+/$f8}"
    done
}
hist_add() {   # hist_add bad|warn|ok|info TEXT : one line in $TMP/history.log; bad / warn / ok also go to the panel
    local tag="[  ]" ts
    case $1 in bad) tag="[!!]"; ((BELL)) && H_RING=1 ;; warn) tag="[! ]" ;; ok) tag="[ok]" ;; esac
    printf -v ts '%(%H:%M:%S)T' -1
    printf '%s %s %s\n' "$ts" "$tag" "$2" >>"$TMP/history.log"
    if [[ $1 != info ]]; then
        ((H_CNT++)); H_RECENT=("$1"$'\037'"$ts $2" "${H_RECENT[@]:0:4}")
    fi
}
hist_reset() { H_INIT=0; H_NODE=(); H_POD=(); H_WL=(); H_XR=(); }   # scope changed (namespace / context): new baseline, no fake diffs
hist_diff() {
    local node v old i key st ost ors ob ord rs b k sev w s
    local -A seen=()
    if ((!H_INIT)); then      # baseline: remember everything, log one summary line
        for node in "${!NODEINFO[@]}"; do H_NODE[$node]="${NODEINFO[$node]%%  *}|${NODE_COND[$node]}"; done
        for ((i = 0; i < NPODS; i++)); do H_POD[${P_NS[i]}/${P_NAME[i]}]="${P_BAD[i]}|${P_STATUS[i]}|${P_RESTARTS[i]}|${P_READY[i]}"; done
        for k in "${!WLS[@]}"; do H_WL[$k]=${WLS[$k]}; done
        for k in "${!XRS[@]}"; do H_XR[$k]=${XRS[$k]}; done
        local nn=${#NODEINFO[@]} nr=0; for node in "${!NODEINFO[@]}"; do [[ ${NODEINFO[$node]} == Ready* ]] && ((nr++)); done
        t h_start; printf -v s "$S" "${CTX:+$CTX }${NS:-*}  nodes $nr/$nn Ready  pods $NPODS (not ready $BADCOUNT)  workloads short $WL_SHORT"
        hist_add info "$s"
        H_INIT=1; return
    fi
    H_RING=0
    t h_node; local L_NODE=$S; t h_new; local L_NEW=$S; t h_gone; local L_GONE=$S; t h_rs; local L_RS=$S; t h_fix; local L_FIX=$S
    for node in "${!NODEINFO[@]}"; do             # nodes: Ready / cordon / pressure transitions
        v="${NODEINFO[$node]%%  *}|${NODE_COND[$node]}"
        if [[ -z ${H_NODE[$node]+x} ]]; then hist_add info "$L_NODE $node $L_NEW (${v%|})"
        elif [[ ${H_NODE[$node]} != "$v" ]]; then
            old=${H_NODE[$node]}; sev=ok
            [[ $v == *SchedulingDisabled* ]] && sev=warn
            [[ $v != Ready* || ${v#*|} != "" ]] && sev=bad
            hist_add "$sev" "$L_NODE $node ${old%|}$G_TO${v%|}"
        fi
        H_NODE[$node]=$v
    done
    for node in "${!H_NODE[@]}"; do [[ -n ${NODEINFO[$node]+x} ]] || { hist_add warn "$L_NODE $node $L_GONE"; unset "H_NODE[$node]"; }; done
    for ((i = 0; i < NPODS; i++)); do              # pods: restarts, broken / recovered, status moves, new / gone
        key="${P_NS[i]}/${P_NAME[i]}"; seen[$key]=1; b=${P_BAD[i]}; st=${P_STATUS[i]}; rs=${P_RESTARTS[i]}
        v="$b|$st|$rs|${P_READY[i]}"
        if [[ -z ${H_POD[$key]+x} ]]; then
            hist_add info "$L_NEW $key ($st) @${P_NODE[i]}"
        elif [[ ${H_POD[$key]} != "$v" ]]; then
            IFS='|' read -r ob ost ors ord <<<"${H_POD[$key]}"
            if ((rs > ors)); then last_term "$i"; w=""; [[ $st != "$ost" ]] && w=" $ost$G_TO$st"; hist_add bad "$L_RS $key +$((rs - ors)) (${LT:-?})$w @${P_NODE[i]}"
            elif ((b && !ob)); then hist_add bad "$key $ost$G_TO$st ${P_READY[i]} @${P_NODE[i]}"
            elif ((!b && ob)); then hist_add ok "$key $ost$G_TO$st ${P_READY[i]}"
            elif [[ $st != "$ost" ]]; then hist_add info "$key $ost$G_TO$st"; fi
        fi
        H_POD[$key]=$v
    done
    for key in "${!H_POD[@]}"; do [[ -n ${seen[$key]+x} ]] || { IFS='|' read -r ob ost ors ord <<<"${H_POD[$key]}"; hist_add info "$L_GONE $key ($ost)"; unset "H_POD[$key]"; }; done
    if ((WL_HAVE && !WL_FAIL)); then               # workloads: short / rolling / back to ok
        for k in "${!WLS[@]}"; do
            v=${WLS[$k]}
            if [[ -z ${H_WL[$k]+x} ]]; then [[ $v != ok* ]] && hist_add warn "$k ${v#* } (${v%% *})"
            elif [[ ${H_WL[$k]} != "$v" ]]; then
                old=${H_WL[$k]}
                case ${v%% *} in
                    short) t p_short; hist_add bad "$k ${old#* }$G_TO${v#* } $S" ;;
                    roll) t h_roll; [[ ${old%% *} != roll ]] && hist_add warn "$k $S ${v#* }" ;;
                    ok) t p_ok; [[ ${old%% *} != ok ]] && hist_add ok "$k ${old#* }$G_TO${v#* } $S" ;;
                esac
            fi
            H_WL[$k]=$v
        done
        for k in "${!H_WL[@]}"; do [[ -n ${WLS[$k]+x} ]] || unset "H_WL[$k]"; done
    fi
    for k in "${!XRS[@]}"; do                     # pvc / job / hpa problems appearing and going away
        v=${XRS[$k]}
        if [[ ${H_XR[$k]-} != "$v" ]]; then sev=warn; [[ $v == *short ]] && sev=bad; hist_add "$sev" "$k ${v% *}"; fi
        H_XR[$k]=$v
    done
    for k in "${!H_XR[@]}"; do [[ -n ${XRS[$k]+x} ]] || { hist_add ok "$k $L_FIX"; unset "H_XR[$k]"; }; done
    ((H_RING)) && printf '\a'
}
regroup() { [[ -s $TMP/pods.tsv ]] && load; }   # grouping / sort changed: re-sort the cached data, no kubectl call

# ---------------------------------------------------------------- tree
is_expanded() {
    if [[ -n ${FOLDED[$1]+x} ]]; then [[ ${FOLDED[$1]} == 0 ]]; else ((DEFAULT_FOLDED == 0)); fi
}
toggle() { if is_expanded "$1"; then FOLDED[$1]=1; else FOLDED[$1]=0; fi; build_rows; }

set_filter() {   # words separated by spaces must all appear in "ns/name node status owner"; !word = must not appear
    FILTER=$1
    local w
    FILTER_WORDS=() FILTER_NOT=()
    read -ra w <<<"${FILTER,,}"
    for w in "${w[@]}"; do
        if [[ $w == !?* ]]; then FILTER_NOT+=("${w#!}"); elif [[ $w != "!" ]]; then FILTER_WORDS+=("$w"); fi
    done
}
match() {   # $1 = pod index
    ((PROBLEMS)) && [[ ${P_BAD[$1]} == 0 && ${P_OOM[$1]} == 0 ]] && { [[ -z ${P_RSEC[$1]} ]] || ((P_RSEC[$1] > 3600)); } && return 1   # bad, OOMKilled or restarted in the last hour
    ((MARKEDONLY)) && [[ -z ${MARK[${P_NS[$1]}/${P_NAME[$1]}]+x} ]] && return 1
    [[ -z $FILTER ]] && return 0
    local hay="${P_NS[$1]}/${P_NAME[$1]} ${P_NODE[$1]} ${P_STATUS[$1]} ${P_WL[$1]} ${P_OWNER[$1]}" t model
    while IFS=$'\037' read -r model _; do hay+=" $model"; done <<<"${AI_MODELS[${P_NS[$1]}/${P_NAME[$1]}]}"
    hay=${hay,,}
    for t in "${FILTER_WORDS[@]}"; do [[ $hay == *"$t"* ]] || return 1; done
    for t in "${FILTER_NOT[@]}"; do [[ $hay == *"$t"* ]] && return 1; done
    return 0
}
add_row() { R_KIND+=("$1"); R_KEY+=("$2"); R_DEPTH+=("$3"); R_IDX+=("$4"); }
group_keys() {   # group_keys POD-INDEX -> G1 G2 (keys of the two group levels, G2 empty for one-level groupings)
    local i=$1 node=${P_NODE[i]} ns=${P_NS[i]}
    case $GROUP in
        node,ns) G1="node:$node"; G2="ns:$node/$ns" ;;
        ns)      G1="ns:$ns"; G2="" ;;
        ns,wl)   G1="ns:$ns"; G2="wl:$ns/${P_WL[i]}" ;;
        node)    G1="node:$node"; G2="" ;;
    esac
}
build_rows() {
    R_KIND=() R_KEY=() R_DEPTH=() R_IDX=()
    CNT=() BAD=() RSUM=()
    local i n node prev1="" prev2="" r G1 G2
    n=${#P_NAME[@]}
    MATCHED=0
    for ((i = 0; i < n; i++)); do              # pass 1: counts per group (after filter)
        match "$i" || continue
        ((MATCHED++))
        group_keys "$i"
        CNT[$G1]=$(( ${CNT[$G1]:-0} + 1 )); BAD[$G1]=$(( ${BAD[$G1]:-0} + ${P_BAD[i]} )); RSUM[$G1]=$(( ${RSUM[$G1]:-0} + ${P_RESTARTS[i]} ))
        [[ -n $G2 ]] && { CNT[$G2]=$(( ${CNT[$G2]:-0} + 1 )); BAD[$G2]=$(( ${BAD[$G2]:-0} + ${P_BAD[i]} )); RSUM[$G2]=$(( ${RSUM[$G2]:-0} + ${P_RESTARTS[i]} )); }
    done
    for ((i = 0; i < n; i++)); do              # pass 2: visible rows
        match "$i" || continue
        group_keys "$i"
        if [[ $G1 != "$prev1" ]]; then prev1=$G1; prev2=""; add_row "${G1%%:*}" "$G1" 0 "$i"; fi
        is_expanded "$G1" || continue
        if [[ -n $G2 ]]; then
            if [[ $G2 != "$prev2" ]]; then prev2=$G2; add_row "${G2%%:*}" "$G2" 1 "$i"; fi
            is_expanded "$G2" || continue
            add_row pod "pod:${P_NS[i]}/${P_NAME[i]}" 2 "$i"
        else
            add_row pod "pod:${P_NS[i]}/${P_NAME[i]}" 1 "$i"
        fi
    done
    if [[ $GROUP == node* && -z $FILTER && $PROBLEMS == 0 && $MARKEDONLY == 0 ]]; then   # nodes without pods
        for node in $(printf '%s\n' "${!NODEINFO[@]}" | LC_ALL=C sort); do
            [[ -n ${CNT[node:$node]+x} ]] || add_row node "node:$node" 0 -1
        done
    fi
    local found=0
    if [[ -n $SEL_KEY ]]; then                 # keep the same row selected across refreshes
        for ((r = 0; r < ${#R_KIND[@]}; r++)); do
            [[ ${R_KEY[r]} == "$SEL_KEY" ]] && { SEL=$r; found=1; break; }
        done
    fi
    if ((!found)) && [[ -n $FILTER ]]; then    # filtering: land on the first matching pod
        for ((r = 0; r < ${#R_KIND[@]}; r++)); do
            [[ ${R_KIND[r]} == pod ]] && { SEL=$r; break; }
        done
    fi
    clamp
    DIRTY=1
}
clamp() {
    local n=${#R_KIND[@]}
    ((SEL >= n)) && SEL=$((n - 1))
    ((SEL < 0)) && SEL=0
    if ((n)); then SEL_KEY=${R_KEY[SEL]}; else SEL_KEY=""; fi
}
parent() {
    local d=${R_DEPTH[SEL]} r
    for ((r = SEL - 1; r >= 0; r--)); do ((R_DEPTH[r] < d)) && { SEL=$r; break; }; done
    clamp
}
pods_under() {   # pods_under ROW -> UNDER[] = pod indexes below this group row (after filter); a pod row gives itself
    local r=$1 kind=${R_KIND[r]} key=${R_KEY[r]} i n=${#P_NAME[@]} G1 G2
    UNDER=()
    if [[ $kind == pod ]]; then UNDER=("${R_IDX[r]}"); return; fi
    for ((i = 0; i < n; i++)); do
        match "$i" || continue
        group_keys "$i"
        [[ $G1 == "$key" || $G2 == "$key" ]] && UNDER+=("$i")
    done
}

# ---------------------------------------------------------------- drawing
status_color() {   # status_color VAR STATUS READY
    local st=$2 ready=$3 c
    case $st in
        Completed|Succeeded) c=$C_DIM ;;
        Running) if [[ ${ready%/*} == "${ready#*/}" ]]; then c=$C_OK; else c=$C_WARN; fi ;;
        *Err*|*BackOff*|*Fail*|*OOM*|*Evict*|*ExitCode*|*Signal*|*Unknown*|*NotReady*|*Invalid*|*Deadline*) c=$C_BAD ;;
        *) c=$C_WARN ;;
    esac
    printf -v "$1" '%s' "$c"
}
layout() {   # column widths for the current terminal / options
    local fixed=$((2 + 8 + 19 + 9 + 8))
    SHOW_AI=0
    if ((AI_ON && COLUMNS>=140)) && ((${#AI_STATE[@]})); then SHOW_AI=1; fixed=$((fixed+31)); fi
    SHOW_NODE=0; [[ $GROUP == ns* ]] && SHOW_NODE=1
    ((WIDE)) && { fixed=$((fixed + 16 + 13 + 25)); SHOW_NODE=0; }
    ((SHOW_NODE)) && fixed=$((fixed + 13))
    ((TOPON)) && fixed=$((fixed + 8 + 9))
    NAME_W=$((COLUMNS - 1 - fixed)); ((NAME_W < 12)) && NAME_W=12
}
render_row() {   # render_row ROW SELECTED  -> LINE
    local r=$1 sel=$2 kind=${R_KIND[r]} key=${R_KEY[r]} depth=${R_DEPTH[r]} i=${R_IDX[r]}
    local indent text plain w=$((COLUMNS - 1)) fill
    printf -v indent '%*s' $((depth * 2)) ''
    if [[ $kind == pod ]]; then
        local c rc="" name fr fs frs fa mk="" ch=" " rs pk="${P_NS[i]}/${P_NAME[i]}" base extra="" pextra=""
        status_color c "${P_STATUS[i]}" "${P_READY[i]}"
        if [[ -n ${P_RSEC[i]} ]] && ((P_RSEC[i] <= 600)); then rc=$C_BAD; elif [[ -n ${P_RSEC[i]} ]] && ((P_RSEC[i] <= 3600)); then rc=$C_WARN; elif [[ ${P_RESTARTS[i]} != 0 ]]; then rc=$C_DIM; fi   # restarted: <10m red, <1h yellow, older dim
        [[ -n ${MARK[$pk]+x} ]] && mk="${C_MAG}${G_MARK}${C_END}" || mk=" "
        [[ -n ${CHG[$pk]+x} ]] && ch="${C_WARN}${C_BOLD}${G_CHG}${C_END}"
        [[ -n ${NEWP[$pk]+x} ]] && ch="${C_OK}${C_BOLD}${G_NEW}${C_END}"
        rs=${P_RESTARTS[i]}; base=${BASE_RS[$pk]:-$rs}
        ((rs > base)) && rs="$rs+$((rs - base))"
        name=${P_NAME[i]}; [[ $GROUP == node ]] && name="${P_NS[i]}/${P_NAME[i]}"
        pad name "${indent}  ${name}" "$NAME_W"
        pad fr "${P_READY[i]}" 7; pad fs "${P_STATUS[i]}" 18; pad frs "$rs" 8; pad fa "${P_AGE[i]}" 7
        text="${mk}${ch}${name} ${c}${fr}${C_END} ${c}${fs}${C_END} ${rc}${frs}${C_END} ${fa}"
        plain="  ${name} ${fr} ${fs} ${frs} ${fa}"
        if ((WIDE)); then
            local ip=${P_IP[i]:--} nd=${P_NODE[i]} ow=${P_WL[i]#Pod/}
            [[ $nd == "~" ]] && nd="-"
            pad ip "$ip" 15; pad nd "$nd" 12; pad ow "$ow" 24
            extra=" ${C_DIM}${ip}${C_END} ${nd} ${C_NS}${ow}${C_END}"; pextra=" ${ip} ${nd} ${ow}"
        elif ((SHOW_NODE)); then
            local nd=${P_NODE[i]}; [[ $nd == "~" ]] && nd="-"
            pad nd "$nd" 12; extra=" ${nd}"; pextra=" ${nd}"
        fi
        if ((TOPON)); then
            local cpu=${TOP_CPU[$pk]:--} mem=${TOP_MEM[$pk]:--}
            pad cpu "$cpu" 7; pad mem "$mem" 8; extra+=" ${cpu} ${mem}"; pextra+=" ${cpu} ${mem}"
        fi
        if ((SHOW_AI)); then
            local stats='-' F=() sk="P|$pk|${AI_PMODEL[$pk]}" a b k o
            if [[ -n ${AI_DATA[$pk]} && -n ${AI_P[$pk|${AI_PMODEL[$pk]}]} ]]; then
                # RUN / WAIT with the change since the previous collection, KV %, completions in the last interval, OUT tok/s
                F=(${AI_P[$pk|${AI_PMODEL[$pk]}]})
                ai_prev "$sk|run"; ai_dcell "${F[2]}" "$PREV" 8 "$C_NS" "$C_DIM" ""; a=$CELL
                local wc=""; [[ ${F[3]} != - ]] && ((F[3] > 0)) && wc=$C_WARN
                ai_prev "$sk|wait"; ai_dcell "${F[3]}" "$PREV" 8 "$C_BAD" "$C_OK" "$wc"; b=$CELL
                k=-; [[ ${F[4]} != - ]] && k="${F[4]}%"
                o=-; [[ ${F[5]} != - ]] && o="+${F[5]}"
                local out; ai_num out "${F[7]}"
                printf -v stats '%4s %-4s%5s' "$k" "$o" "$out"
                stats="$a$b$stats"
                if [[ -n ${AI_SEEN[$pk]} ]] && ((NOW-AI_SEEN[$pk]>30)); then pad stats 'STALE (V: sample age)' 30; fi
                extra+=" $stats"; ai_plain stats "$stats"; pextra+=" $stats"
            else
                [[ ${AI_TYPE[$pk]} == vllm ]] && stats='N/A (V: collection status)'
                pad stats "$stats" 30; extra+=" $stats"; pextra+=" $stats"
            fi
        fi
        text+=$extra; plain+=$pextra
    else
        local marker cnt bad s="s" info nc rsum label
        if is_expanded "$key"; then marker=$G_OPEN; else marker=$G_CLOSED; fi
        cnt=${CNT[$key]:-0}; bad=${BAD[$key]:-0}; rsum=${RSUM[$key]:-0}
        t pods; label=$S; [[ $UI == en ]] && ((cnt == 1)) && label="pod"
        if [[ $kind == node ]]; then
            local node=${key#node:}
            if [[ $node == "~" ]]; then
                t unsched; text="  ${indent}${marker} ${C_BOLD}${S}${C_END}"; plain="  ${indent}${marker} ${S}"
                t pending_nonode; text+="  ${C_WARN}${S}${C_END}"; plain+="  ${S}"
            else
                info=${NODEINFO[$node]}
                nc=$C_WARN
                [[ $info == Ready* ]] && nc=$C_OK
                [[ $info == NotReady* || -n ${NODE_COND[$node]} ]] && nc=$C_BAD
                text="  ${indent}${marker} ${C_BOLD}${node}${C_END}${info:+  ${nc}${info}${C_END}}"
                plain="  ${indent}${marker} ${node}${info:+  ${info}}"
                if ((AI_ON)); then
                    local gs=${AI_NODE_GPU[$node]:-GPU N/A}
                    [[ -n ${AI_GPU_SEEN[$node]} ]] && ((NOW-AI_GPU_SEEN[$node]>30)) && gs+=' [STALE]'
                    text+="  ${C_NS}$gs${C_END}"; plain+="  $gs"
                fi
                if ((TOPON)) && [[ -n ${TOPN_CPU[$node]+x} ]]; then
                    text+="  ${C_DIM}cpu ${TOPN_CPU[$node]}  mem ${TOPN_MEM[$node]}${C_END}"; plain+="  cpu ${TOPN_CPU[$node]}  mem ${TOPN_MEM[$node]}"
                fi
            fi
        elif [[ $kind == wl ]]; then
            local wl=${key#wl:}; wl=${wl#*/}
            text="  ${indent}${marker} ${C_NS}${C_BOLD}${wl}${C_END}"; plain="  ${indent}${marker} ${wl}"
        else
            local ns=${key#ns:}; ns=${ns##*/}
            text="  ${indent}${marker} ${C_NS}${C_BOLD}${ns}${C_END}"; plain="  ${indent}${marker} ${ns}"
        fi
        text+="  ${C_DIM}${cnt} ${label}${C_END}"; plain+="  ${cnt} ${label}"
        if ((bad)); then t notready; text+="${C_WARN}, ${bad} ${S}${C_END}"; plain+=", ${bad} ${S}"; fi
        if ((rsum)); then t restarts; text+="${C_DIM}, ${rsum} ${S}${C_END}"; plain+=", ${rsum} ${S}"; fi
    fi
    PLAIN=$plain
    local pw; dw pw "$plain"
    if ((pw > w)); then padw text "$plain" "$w"
    else printf -v fill '%*s' $((w - pw)) ''; text+=$fill; fi
    if ((sel)); then LINE="${C_REV}${text}${C_RST}"; else LINE="${text}${C_RST}"; fi
}
detail_lines() {   # -> D1 D2 for the selected row (plain text, no colors: rendered dim)
    local kind=${R_KIND[SEL]} key=${R_KEY[SEL]} i=${R_IDX[SEL]} n=${#R_KIND[@]}
    D1="" D2=""
    ((n)) || return
    if [[ $kind == pod ]]; then
        local hn=""; [[ ${P_HOSTNET[i]} == true ]] && hn="  hostNetwork"
        D1="${P_NS[i]}/${P_NAME[i]}  ip ${P_IP[i]:--}  host ${P_HIP[i]:--}${hn}  node ${P_NODE[i]/#\~/-}  ${P_WL[i]}${P_OWNER[i]:+ (${P_OWNER[i]})}  qos ${P_QOS[i]:--}  sa ${P_SA[i]:--}"
        [[ -n ${P_RAGO[i]} ]] && D1+="  last restart ${P_RAGO[i]} ago"
        local c f parts=()
        IFS='|' read -ra parts <<<"${P_CTR[i]}"
        for c in "${parts[@]}"; do
            [[ -n $c ]] || continue
            IFS=';' read -r f1 f2 f3 f4 f5 f6 f7 f8 f9 f10 <<<"$c"
            local st=$f2; [[ -n $f3 ]] && st+=":$f3"; [[ $f2 == Terminated ]] && st+=" exit=$f4"
            local ok=$G_NG; [[ $f6 == true ]] && ok=$G_OK
            [[ $f10 == init ]] && ok="init"
            D2+="${D2:+ | }$f1 $ok $st ${G_RS}$f5"
            [[ -n $f7 ]] && D2+=" last=$f7${f8:+/$f8}${f9:+($f9)}"
        done
        [[ -z $D2 ]] && D2="containers: ${P_CNAMES[i]%,}"
        local pk="${P_NS[i]}/${P_NAME[i]}" model
        if ((AI_ON)) && [[ -n ${AI_STATE[$pk]} ]]; then
            if [[ -n ${AI_DATA[$pk]} ]]; then
                ai_values "${AI_DATA[$pk]}"; model=${AI_MODELS[$pk]%%$'\037'*}
                D1="$pk  MODEL $model  CPU ${TOP_CPU[$pk]:-N/A}  MEM ${TOP_MEM[$pk]:-N/A}  [V: details]"
                D2="RUN $AV_RUN  WAIT $AV_WAIT  KV(max) ${AV_KV}${AV_KV_UNIT}  OUT $AV_OUT tok/s  DONE +$AV_DELTA/${AV_DT}s  total $AV_DONE"
            else D2="vLLM/GPU: ${AI_STATE[$pk]}  [V: details]"; fi
        fi
    elif [[ $kind == node ]]; then
        local node=${key#node:}
        [[ $node == "~" ]] && return
        local alloc=${NODE_ALLOC[$node]%%;*} misc=${NODE_MISC[$node]} addr=${NODE_ADDR[$node]}
        IFS=';' read -r os rt kern created <<<"$misc"
        D1="$node  ${NODEINFO[$node]}  ${addr%,}  podCIDR ${NODE_CIDR[$node]:--}  pods ${CNT[$key]:-0}/${alloc:-?}"
        [[ -n ${NODE_TAINT[$node]} ]] && D1+="  taints ${NODE_TAINT[$node]%,}"
        D2="${os:--}  ${rt:--}  ${kern:--}${NODE_COND[$node]:+  !! ${NODE_COND[$node]}}"
    else
        t pods; D1="${key#*:}  ${CNT[$key]:-0} $S"; t notready; D1+=", ${BAD[$key]:-0} $S"; t restarts; D1+=", ${RSUM[$key]:-0} $S"
    fi
}
# status panel line builder: pieces are added while they fit in PL_MAX columns (colors do not count).  Once a piece does not
# fit, the rest of that section is skipped too (pl_sec starts a new section), so a line never shows a later detail without the earlier one
pl_reset() { PL_T=""; PL_W=0; PL_FULL=0; }
pl_sec() { PL_FULL=0; }
pl_add() {   # pl_add TEXT [COLOR] ; 1 when it does not fit (nothing added)
    ((PL_FULL)) && return 1
    local w; dw w "$1"
    ((PL_W + w > PL_MAX)) && { PL_FULL=1; return 1; }
    if [[ -n $2 ]]; then PL_T+="$2$1$C_END"; else PL_T+=$1; fi
    PL_W=$((PL_W + w))
}
pl_fit() {   # pl_fit TEXT [COLOR] : as much of TEXT as still fits
    local r=$((PL_MAX - PL_W)) s
    ((r <= 0 || PL_FULL)) && return
    s=${1:0:r}; padw s "$s" "$r"; s=${s%"${s##*[! ]}"}
    [[ -n $s ]] && pl_add "$s" "$2"
}
pct_color() {   # pct_color VAR PERCENT
    local p=${2%\%}; p=${p%%.*}
    if [[ ! $p =~ ^[0-9]+$ ]]; then printf -v "$1" '%s' "$C_DIM"
    elif ((p >= 90)); then printf -v "$1" '%s' "$C_BAD"
    elif ((p >= 75)); then printf -v "$1" '%s' "$C_WARN"
    else printf -v "$1" '%s' ""; fi
}
node_cell() {   # node_cell NODE -> CELL (colored) CELL_W ; status dot, name, problems, cpu / mem %, pods/allocatable, !bad ↻restarted
    local node=$1 info=${NODEINFO[$1]} nc=$C_OK c m cc mc tag="" np=${NODE_NP[$1]:-0} nb=${NODE_NB[$1]:-0} alloc=${NODE_ALLOC[$1]%%;*} plain
    local rsn=${NODE_RSINCE[$1]} rr=${NODE_RR[$1]:-0} h
    [[ $info == *SchedulingDisabled* ]] && { nc=$C_WARN; t p_cordon; tag=" $S"; }
    if [[ $info != Ready* ]]; then nc=$C_BAD; h=""; [[ -n $rsn ]] && hum h "$rsn"; tag=" ${info%%[, ]*}${h:+ $h}$tag"   # NotReady for how long
    elif [[ -n $rsn ]] && ((rsn < 1800)); then hum h "$rsn"; [[ $nc == "$C_OK" ]] && nc=$C_WARN; tag+=" Ready↑$h"; fi  # came back recently
    [[ -n ${NODE_COND[$node]} ]] && { nc=$C_BAD; tag+=" ${NODE_COND[$node]}"; }
    if ((METRICS)); then c=${TOPN_CPU[$node]#* }; m=${TOPN_MEM[$node]#* }; [[ -n ${TOPN_CPU[$node]} ]] || { c=-; m=-; }
    else c=${NODE_RQC[$node]:--}; m=${NODE_RQM[$node]:--}; [[ $c == -1 ]] && c=-; [[ $m == -1 ]] && m=-; [[ $c != - ]] && c+=%; [[ $m != - ]] && m+=%; fi
    pct_color cc "$c"; pct_color mc "$m"
    t p_pods
    if ((COLUMNS < 120)); then   # narrow: status and problems only
        CELL="${nc}${G_DOT} ${C_BOLD}${node}${C_END}${tag:+${nc}${tag}${C_END}}"; plain="${G_DOT} ${node}${tag}"
    else
        CELL="${nc}${G_DOT} ${C_BOLD}${node}${C_END}${tag:+${nc}${tag}${C_END}} cpu ${cc}${c}${C_END} mem ${mc}${m}${C_END} ${C_DIM}${S} ${np}/${alloc:-?}${C_END}"
        plain="${G_DOT} ${node}${tag} cpu ${c} mem ${m} ${S} ${np}/${alloc:-?}"
    fi
    ((nb)) && { CELL+=" ${C_BAD}!${nb}${C_END}"; plain+=" !${nb}"; }
    ((rr)) && { CELL+=" ${C_WARN}${G_RS}${rr}${C_END}"; plain+=" ${G_RS}${rr}"; }
    dw CELL_W "$plain"
}
panel_build() {   # -> PANEL_OUT (lines ending in \e[K\n), PANEL_H
    PANEL_OUT="" PANEL_H=0
    ((PANEL)) && ((LINES >= 14)) && ((LOADED)) || return
    local maxl=1 node nn=0 nr=0 lines=1 extra=0 lead lw ind i n=${#NODE_ORDER[@]} left it c
    ((LINES >= 28)) && maxl=2; ((LINES >= 40)) && maxl=3
    PL_MAX=$((COLUMNS - 1))
    METRICS=0; ((${#TOPN_CPU[@]})) && METRICS=1
    # nodes: one cell per node, wrapped over up to maxl lines; the rest are counted as +N
    for node in "${NODE_ORDER[@]}"; do ((nn++)); [[ ${NODEINFO[$node]} == Ready* ]] && ((nr++)); done
    pl_reset
    t p_nodes; lead=" $S "; pl_add "$lead" "$C_BOLD"
    c=$C_OK; ((nr < nn)) && c=$C_BAD; pl_add "$nr/$nn Ready" "$c"
    if ((METRICS)); then t p_usage; else t p_req; fi; pl_add " ($S)" "$C_DIM"
    dw lw "$lead"; printf -v ind '%*s' "$lw" ''
    for ((i = 0; i < n; i++)); do
        node_cell "${NODE_ORDER[i]}"
        left=$((n - i - 1)); local room=$PL_MAX; ((lines == maxl && left > 0)) && room=$((PL_MAX - 6))
        if ((PL_W + 3 + CELL_W <= room)); then PL_T+="  ${C_DIM}${G_VB}${C_END} $CELL"; PL_W=$((PL_W + 3 + CELL_W)); continue; fi
        if ((lines < maxl)); then
            PANEL_OUT+="$PL_T"$'\e[K\n'; ((lines++)); pl_reset; pl_add "$ind"
            if ((lines == maxl && left > 0)); then room=$((PL_MAX - 6)); else room=$PL_MAX; fi
            if ((PL_W + CELL_W <= room)); then PL_T+=$CELL; PL_W=$((PL_W + CELL_W)); continue; fi
        fi
        pl_add "  +$((n - i))" "$C_BOLD"; break
    done
    PANEL_OUT+="$PL_T"$'\e[K\n'
    # pods
    pl_reset
    t p_pods; pl_add " $S $NPODS" "$C_BOLD"; pl_add "  Running $ST_RUN"
    ((ST_PEND)) && { t p_pend; pl_add "  $S $ST_PEND" "$C_WARN"; }
    ((ST_CRASH)) && { t p_crash; pl_add "  $S $ST_CRASH" "$C_BAD"; }
    ((ST_OTHER)) && { t p_other; pl_add "  $S $ST_OTHER" "$C_WARN"; }
    ((ST_OOM)) && { t p_oom; pl_add "  $S $ST_OOM" "$C_BAD"; }
    ((ST_RREC)) && { t p_rs1h; pl_add "  $S $ST_RREC" "$C_WARN"; }
    ((RS_GROW)) && { t p_rs; pl_add "  $S +$RS_GROW" "$C_WARN"; pl_add " ($RS_TOPK)" "$C_DIM"; }
    # workloads: same line on wide terminals, own line on narrow ones
    pl_sec
    if ((COLUMNS < 140)); then PANEL_OUT+="$PL_T"$'\e[K\n'; ((extra++)); pl_reset; pl_add " "; else pl_add "  ${G_VB} " "$C_DIM"; fi
    t p_wl; pl_add "$S " "$C_BOLD"
    if ((WL_FAIL)); then t p_na; pl_add "$S" "$C_DIM"
    elif ((!WL_HAVE)); then t p_wait; pl_add "$S" "$C_DIM"
    else
        pl_add "$WL_TOTAL"
        ((WL_SHORT)) && { t p_short; pl_add "  $S $WL_SHORT" "$C_BAD"; }
        ((WL_ROLL)) && { t p_roll; pl_add "  $S $WL_ROLL" "$C_WARN"; }
        t p_ok; pl_add "  $S $WL_OK" "$C_OK"
        ((XR_PVC)) && { t p_pvc; pl_add "  $S $XR_PVC" "$C_BAD"; }
        ((XR_JOB)) && { t p_job; pl_add "  $S $XR_JOB" "$C_BAD"; }
        ((XR_HPA)) && { t p_hpa; pl_add "  $S $XR_HPA" "$C_WARN"; }
        n=0
        for it in "${WL_ITEMS[@]}"; do
            c=$C_BAD; [[ $it == roll* ]] && c=$C_WARN
            it=${it#* }
            if ((n == 0)); then pl_add ":  " || break; else pl_add ", " || break; fi
            pl_add "$it" "$c" || { PL_FULL=0; pl_add "$G_ELL"; break; }
            ((n++))
        done
    fi
    PANEL_OUT+="$PL_T"$'\e[K\n'
    # warning events: count, (top reasons on wide terminals), the newest one
    pl_reset
    t p_ev; pl_add " $S " "$C_BOLD"
    if ((!EV_HAVE)); then t p_wait; pl_add "$S" "$C_DIM"
    else
        c=$C_OK; ((EV_N > 0)) && c=$C_WARN; ((EV_N >= 20)) && c=$C_BAD
        pl_add "$EV_N" "$c"
        [[ -n $EV_TOP ]] && ((COLUMNS >= 140)) && { pl_add "  ($EV_TOP)" "$C_DIM"; pl_sec; }
        if [[ -n $EV_AGE ]]; then
            t p_ago; printf -v it "$S" "$EV_AGE"
            pl_add "  ${G_VB} " "$C_DIM"; pl_add "$it " "$C_DIM"; pl_add "$EV_REASON " "$C_WARN"; pl_fit "$EV_OBJ" "$C_NS"
            pl_fit ": $EV_MSG"
        fi
    fi
    PANEL_OUT+="$PL_T"$'\e[K\n'
    # changes since start (H): count, the newest few, newest first; hidden on short terminals
    if ((LINES >= 20)); then
        pl_reset
        t p_chg; pl_add " $S (H) " "$C_BOLD"
        if ((H_CNT == 0)); then t p_none; pl_add "$S" "$C_DIM"
        else
            pl_add "$H_CNT"
            local cap=$(((PL_MAX - PL_W) / 3 - 12)) body
            ((cap < 36)) && cap=36
            for it in "${H_RECENT[@]}"; do
                case ${it%%$'\037'*} in bad) c=$C_BAD ;; ok) c=$C_OK ;; *) c=$C_WARN ;; esac
                it=${it#*$'\037'}; body=${it:9}
                ((${#body} > cap)) && body="${body:0:cap-1}$G_ELL"
                ((PL_MAX - PL_W < 30)) && break
                pl_sec; pl_add "  ${G_VB} " "$C_DIM" || break; pl_add "${it:0:8} " "$C_DIM" || break
                pl_add "$body" "$c" || { PL_FULL=0; pl_fit "$body" "$c"; break; }
            done
        fi
        PANEL_OUT+="$PL_T"$'\e[K\n'; ((extra++))
    fi
    PANEL_H=$((lines + 2 + extra))
}
draw() {
    local sz
    sz=$(stty size 2>/dev/null) && { LINES=${sz% *}; COLUMNS=${sz#* }; }
    layout
    local dh=0; ((DETAIL)) && ((LINES >= 14)) && dh=2
    panel_build
    local body_h=$((LINES - 3 - dh - PANEL_H)) out i r n=${#R_KIND[@]} line left right w hdr frame=()
    ((body_h < 1)) && body_h=1; BODY_H=$body_h
    ((SEL < TOP)) && TOP=$SEL
    ((SEL >= TOP + body_h)) && TOP=$((SEL - body_h + 1))
    ((TOP > n - body_h)) && TOP=$((n - body_h))
    ((TOP < 0)) && TOP=0

    t pods; left=" podtree${CTX:+  ctx:$CTX}${NS:+  ns:$NS}${SEP}${NPODS} ${S}"
    ((BADCOUNT)) && { t notready; left+=" (${BADCOUNT} ${S})"; }
    left+="${SEP}${GROUP/,/>}${SEP}${SORT}${FILTER:+  /$FILTER/}"
    ((PROBLEMS)) && { t problems; left+="  $S"; }
    ((MARKEDONLY)) && { t markedonly; left+="  $S"; }
    [[ -n $FETCH_PID ]] && left+="  ${G_RS}"
    if ((AI_ON)); then
        if [[ -n $AI_PID ]]; then left+="  GPU/LLM ..."
        elif ((AI_STAMP)); then
            now_epoch; left+="  GPU/LLM $((NOW-AI_STAMP))s"
        fi
    fi
    right=" ${LAST_REFRESH} "
    padw line "$left" $((COLUMNS - ${#right} - 1))
    out=$'\e[H'"${C_REV}${C_BOLD}${line}${right}${C_RST}"$'\e[K\n'
    out+=$PANEL_OUT

    pad line "    NAME" "$NAME_W"
    hdr="${C_UL}${line}${C_RST} ${C_UL}READY  ${C_RST} ${C_UL}STATUS            ${C_RST} ${C_UL}RESTARTS${C_RST} ${C_UL}AGE    ${C_RST}"
    if ((WIDE)); then hdr+=" ${C_UL}IP             ${C_RST} ${C_UL}NODE        ${C_RST} ${C_UL}OWNER                   ${C_RST}"
    elif ((SHOW_NODE)); then hdr+=" ${C_UL}NODE        ${C_RST}"; fi
    ((TOPON)) && hdr+=" ${C_UL}CPU    ${C_RST} ${C_UL}MEM     ${C_RST}"
    ((SHOW_AI)) && hdr+=" ${C_UL} RUN    WAIT     KV% DONE  OUT${C_RST}"
    out+="$hdr"$'\e[K\n'

    for ((i = 0; i < body_h; i++)); do
        r=$((TOP + i))
        if ((r < n)); then render_row "$r" $((r == SEL)); out+="$LINE"; fi
        out+=$'\e[K\n'
    done
    if ((n == 0)); then
        if [[ -n $ERR ]]; then t kfail; printf -v line "$S" "$ERR"
        elif ((!LOADED)); then t loading; line=$S
        elif [[ -n $FILTER || $PROBLEMS == 1 || $MARKEDONLY == 1 ]]; then t nomatch; line=$S
        else t nopods; line=$S; fi
        out+=$'\e['"$((4 + PANEL_H))"';3H'"${C_WARN}${line}${C_RST}"$'\e['"$((3 + PANEL_H + body_h))"';1H'
    fi
    if ((dh)); then
        detail_lines
        padw line " $D1" $((COLUMNS - 1)); out+="${C_REV}${C_DIM}${line}${C_RST}"$'\e[K\n'
        padw line " $D2" $((COLUMNS - 1)); out+="${C_DIM}${line}${C_RST}"$'\e[K\n'
    fi
    if [[ -n $MSG ]]; then
        padw line " $MSG" $((COLUMNS - 1)); out+="${C_WARN}${C_BOLD}${line}${C_RST}"
    else
        if ((COLUMNS >= 184)); then t hint; else t hint_s; fi
        padw line "$S" $((COLUMNS - 1)); out+="${C_DIM}${line}${C_RST}"
    fi
    # Fixed/minimum-width columns can exceed a narrow terminal (especially --wide
    # and --top). Disable autowrap, cap height, and never newline on the last row:
    # a redraw must not scroll even when the window is resized while a key repeats.
    mapfile -t frame <<<"$out"
    ((${#frame[@]} > LINES)) && frame=("${frame[@]:0:LINES}")
    printf -v out '%s\n' "${frame[@]}"; out=${out%$'\n'}
    printf '\e[?7l%s\e[J\e[?7h' "$out"
    DIRTY=0
}

help_text() {
    if [[ $UI == ko ]]; then cat <<EOF
  podtree.sh v$VERSION                                                  (e = English, k = 한국어)

  트리
    ↑↓  j/k  PgUp/PgDn  Home/End   이동          →/l 펼치기 (파드 위에서는 로그)   ←/h 접기 (파드에서는 부모로)
    Enter        파드: 로그 스트리밍 (kubectl logs -f)     노드/네임스페이스/워크로드: 접기·펼치기
    L            로그를 패턴으로 걸러서 시작 (tail -f | grep -i).  그룹 줄에서는 그 아래 파드 전부를 한 화면에
    p / c        이전 인스턴스(--previous) 로그 / 컨테이너를 골라서 로그
    m  M  u  *   파드 선택(★, 그룹 줄이면 아래 전부) / 선택한 파드 전부의 로그를 한 화면에 / 선택 모두 해제 / 선택한 파드만 보기
    e / E        선택 항목의 이벤트 / 전체(또는 -n) Warning 이벤트 실시간
    v            연결 관계: 이 파드를 고르는 Service·Endpoints(로테이션 포함 여부)·Ingress·NetworkPolicy·PVC·ConfigMap·Secret
    N            네트워크 상태 (2초마다): TCP 상태별 수, LISTEN 포트, SYN backlog/drop, 재전송, conntrack, FD, CPU/MEM, NIC
    T            패킷 캡처: 이 서버 tcpdump / 컨테이너 안 tcpdump / kubectl debug 컨테이너 / ssh 중 가능한 것
    D            대시보드: 클러스터·노드(요청량 포함)·미달 워크로드·이 서버 자원, 최근 Warning 이벤트
    V            vLLM 모니터: 모델 > 파드 표 (←→ Enter 접기, +/- 전체). 실행/대기 ▲▼ 변화, 완료 +건, 부하·완료 추이, KV/GPU/VRAM/CPU/MEM
                 하단 변화창(e), L 변화로그, d 상세, o 정렬, t 트리로 이동, S 저장. 5초 주기. 추론 요청 수이며 사용자 세션 수 아님
    w            상단 상태판 켜기/끄기 (기본 켬): 노드별 상태·CPU/MEM·파드 수 (metrics-server 있으면 사용률, 없으면 요청량/할당량),
                 파드 대기/오류/재시작 증가, 준비 안 된·롤아웃 중인 Deployment/StatefulSet/DaemonSet, 최근 10분 Warning 이벤트
    d / y / K    describe / yaml / 선택 항목의 kubectl 명령 보기
    s / P        파드 셸 (kubectl exec) / 포트포워드
    /            필터 (치는 대로): 공백으로 나눈 단어 모두 일치, !단어 = 제외, 대상 네임스페이스/이름/노드/상태/소유자. Esc 해제
    !            문제 파드만 (비정상 + 최근 1시간 안에 재시작했거나 OOMKilled 된 파드)      g  트리 단계: node>ns → ns → ns>wl(워크로드) → node
    I            문제 목록: 노드(NotReady 지속시간·pressure·cordon·최근 복구)·미달 워크로드·PVC 대기·Job 실패·HPA 최대·문제 파드·최근 재시작을
                 한 목록으로, 글자 입력으로 거르고 Enter 면 그 파드·노드로 이동 (나머지는 describe)
    H            변화 기록: 시작 후 노드 상태 전환, 파드 재시작(사유 OOMKilled/137 등)·고장·회복, 워크로드 미달·회복, PVC·Job·HPA 문제를
                 시각과 함께 쌓아 보여줌 (Space 둘러보기, S 저장). --bell 이면 고장([!!])마다 벨
    o            정렬: name → status → restarts → age        i  IP/노드/소유자 컬럼      t  CPU/MEM 컬럼 (kubectl top)
    Tab          하단 상세 표시줄 켜기/끄기     + / -  전부 펼치기 / 접기     r  지금 갱신     S  트리 저장     a  ▾▸ ↔ -+
    Del / R / X  파드 삭제 / rollout restart / 노드 cordon·uncordon (확인 후 실행, --read-only 면 비활성)
    n / C        네임스페이스 선택 / kubectl 컨텍스트 선택       \\  한/영 전환      q  종료
    기호:  ★ 선택한 파드   Δ 이번 갱신에 바뀜   + 새 파드   재시작 7+2 = 시작 후 2번 늘어남
           재시작 숫자 색: 빨강 10분 안, 노랑 1시간 안, 흐림 그 전.  상태판 노드 칸: !N 비정상 파드  ↻N 1시간 안 재시작 파드  Ready↑5m 최근 복구

  로그 화면 (2단계)
    1 스트리밍   레벨별 색 (ERROR 빨강, WARN 노랑, DEBUG 흐림), 파드마다 접두어 색
                 & 또는 /  실시간 필터 (tail -f | grep)     S 저장 (~/podtree-*.log)     Esc/q 복귀
                 Space, Enter, 방향키, Ctrl-C → 2단계.  다른 키는 무시(실수로 멈추지 않게)
    2 less       ↑↓ PgUp PgDn 스크롤   /텍스트 n N 검색   &텍스트 그 줄만 (&!텍스트 제외, & 만 = 전체)
                 F 다시 따라가기 (Ctrl-C 중지)   G 끝   g 처음   Esc Esc 또는 q 복귀
EOF
    else cat <<EOF
  podtree.sh v$VERSION                                                  (e = English, k = 한국어)

  TREE
    Up/Down j/k PgUp/PgDn Home/End  move       Right/l unfold (on a pod: logs)   Left/h fold (on a pod: parent)
    Enter        pod: stream logs (kubectl logs -f)      node / namespace / workload: fold or unfold
    L            logs showing only lines matching a pattern (tail -f | grep -i); on a group row: all pods below it, one screen
    p / c        previous instance logs (--previous) / pick a container, then logs
    m  M  u  *   mark pod / logs of all marked pods in one screen / unmark all / show marked pods only
    e / E        events of the selection / live Warning events (all namespaces or -n)
    v            relations: Services selecting this pod, Endpoints (in rotation or not), Ingress, NetworkPolicy, PVC, ConfigMap, Secret
    N            network stats every 2s: TCP states, LISTEN ports, SYN backlog / drops, retransmits, conntrack, FDs, CPU/MEM, NIC
    T            packet capture: local tcpdump / tcpdump in the container / kubectl debug container / ssh, whichever works
    D            dashboard: cluster, nodes (with requests), workloads short of replicas, this host's resources, recent Warning events
    V            vLLM monitor: model > pod table (←→ Enter fold, +/- all). run/wait with ▲▼ change, done +n, load / done trends, KV/GPU/VRAM/CPU/MEM
                 change pane (e), L change log, d details, o sort, t jump to tree, S save. 5s sampling. Requests are not user sessions
    w            status panel on top on/off (default on): per node status, CPU/MEM, pod count (usage with metrics-server, else
                 requests / allocatable), pending / failing pods and restart growth, Deployments / StatefulSets / DaemonSets not ready or
                 rolling out, Warning events of the last 10 minutes
    d / y / K    describe / yaml / kubectl commands for the selection
    s / P        shell into the pod (kubectl exec) / port-forward
    /            filter as you type: words must all match ns/name/node/status/owner, !word excludes; Esc clears
    !            problem pods only (not ready, or restarted / OOMKilled in the last hour)     g  grouping: node>ns → ns → ns>wl (workload) → node
    I            problems: nodes (NotReady for how long, pressure, cordoned, just back), short workloads, pending PVCs, failed Jobs,
                 HPAs at max, problem pods, recent restarts - one list, type to filter, Enter jumps to the pod / node (others: describe)
    H            change history since start: node transitions, pod restarts (with OOMKilled/137 style reason), breaks and recoveries,
                 workloads short / back, PVC / Job / HPA problems, with times (Space browse, S save). --bell rings on every [!!]
    o            sort: name → status → restarts → age       i  IP/NODE/OWNER columns      t  CPU/MEM columns (kubectl top)
    Tab          detail bar on/off     + / -  unfold / fold all     r  refresh now     S  save tree     a  ▾▸ ↔ -+
    Del / R / X  delete pod / rollout restart / cordon-uncordon node (asks first; off with --read-only)
    n / C        pick namespace / pick kubectl context        \\  Korean / English      q  quit
    marks:  ★ marked   Δ changed in this refresh   + new pod   restarts 7+2 = grew by 2 since start
            restart count color: red within 10m, yellow within 1h, dim older.  panel node cell: !N not-ready pods  ↻N restarted in 1h  Ready↑5m just back

  LOG VIEW (two stages)
    1 streaming  level colors (ERROR red, WARN yellow, DEBUG dim), per-pod prefix colors
                 & or /  live filter (tail -f | grep)     S save (~/podtree-*.log)     Esc/q back
                 Space, Enter, arrows, Ctrl-C → stage 2.  Other keys are ignored (no accidental stop)
    2 less       Up/Down PgUp PgDn scroll   /text n N search   &text only those lines (&!text exclude, & alone = all)
                 F follow again (Ctrl-C stops)   G end   g start   Esc Esc or q back
EOF
    fi
}
show_help() {
    while :; do
        printf '\e[H\e[2J'
        help_text
        IFS= read -rsn1 k
        case $k in e) UI=en ;; k) UI=ko ;; *) break ;; esac
    done
    printf '\e[H\e[2J'; DIRTY=1
}

# ---------------------------------------------------------------- viewers: pager (less) and the two-stage stream view
pager() {   # pager TITLE COMMAND...  (static output)
    local title=$1; shift
    leave_screen
    trap ':' INT
    t less_p2
    if ((HAVE_LESS)); then
        "$@" 2>&1 | less -R -i "${LESSKEY_OPT[@]}" -Ps"${title//./\\.} -- $S"
    else
        "$@" 2>&1
        t press_enter; printf '\n[%s]  %s' "$title" "$S"; IFS= read -r _
    fi
    trap 'exit 130' INT
    enter_screen
}
pager_file() { pager "$1" cat "$2"; }

stop_producers() {
    local p
    for p in "${PRODS[@]}"; do
        command -v pkill >/dev/null 2>&1 && pkill -P "$p" 2>/dev/null     # children of a function producer (kubectl exec, sleep)
        kill "$p" 2>/dev/null
    done
    for p in "${PRODS[@]}"; do wait "$p" 2>/dev/null; done
    PRODS=()
}
producer() {
    if [[ $1 == kc ]]; then ( kc "${@:2}" ) >>"$TMP/log" 2>&1 </dev/null &
    else ( exec "$@" ) >>"$TMP/log" 2>&1 </dev/null & fi
    PRODS+=("$!")
}

producers_alive() { local p; for p in "${PRODS[@]}"; do kill -0 "$p" 2>/dev/null && return 0; done; return 1; }

stream_display() {   # stream_display TITLE PATTERN ROWS : header on rows 1-2, then  tail -f [| grep] [| color]  in the scroll region
    local title=$1 pat=$2 rows=$3 gmode=-E n line
    t only; padw line " $title${pat:+   [$S $pat]}" "$COLUMNS"
    printf '\e[H\e[1;7m%s\e[0m' "$line"
    t stream_h; padw line "$S" "$COLUMNS"
    printf '\e[2;1H\e[2m%s\e[0m' "$line"
    printf '\e[3;1H\e[J'
    rm -f "$TMP/tpid"
    local -a colr=(cat)
    ((COLOR)) && [[ $COLORIZE != none ]] && colr=(awk -v mode="$COLORIZE" -v pfx="$PFXMAP" -f "$TMP/color.awk")
    if [[ -n $pat ]]; then
        grep -qE -- "$pat" /dev/null 2>/dev/null
        [[ $? == 2 ]] && gmode=-F                     # not a valid regex: match it as plain text
        ( "${STDBUF[@]}" tail -n +1 -f "$TMP/log" 2>/dev/null & echo $! >"$TMP/tpid"; wait $! ) \
            | grep --line-buffered -i "$gmode" -- "$pat" | "${colr[@]}" &
        DISP_PID=$!
        for n in 1 2 3 4 5 6 7 8 9 10; do [[ -s $TMP/tpid ]] && break; sleep 0.1; done
    else
        ( "${STDBUF[@]}" tail -n +1 -f "$TMP/log" 2>/dev/null & echo $! >"$TMP/tpid"; wait $! ) | "${colr[@]}" &
        DISP_PID=$!
        for n in 1 2 3 4 5 6 7 8 9 10; do [[ -s $TMP/tpid ]] && break; sleep 0.1; done
    fi
}
stop_display() {
    local tp; tp=$(cat "$TMP/tpid" 2>/dev/null)
    [[ -n $tp ]] && kill "$tp" 2>/dev/null
    [[ -n $DISP_PID ]] && { kill "$DISP_PID" 2>/dev/null; wait "$DISP_PID" 2>/dev/null; }
    DISP_PID=""
}
save_stream() {   # copy the raw stream file to ~/podtree-<slug>-<time>.log ; message on header row 2
    local slug=${1//[^A-Za-z0-9_.-]/_} ts f
    printf -v ts '%(%Y%m%d-%H%M%S)T' -1 2>/dev/null || ts=$(date +%Y%m%d-%H%M%S)
    f=~/podtree-${slug}-${ts}.${2:-log}
    if cp "$TMP/log" "$f" 2>/dev/null; then t saved; printf -v S "$S" "$f"; else t save_fail; fi
    printf '\e7\e[2;1H\e[K\e[1;33m %s\e[0m\e8' "$S"
}
stream_view() {   # stream_view TITLE PATTERN [SUMMARY-FUNCTION]  ; producers must already be started (PRODS)
    local title=$1 pat=$2 sumfn=$3 mode="" rows ended=0 newpat
    leave_screen
    INT_HIT=0
    trap 'INT_HIT=1' INT
    rows=$(stty size 2>/dev/null); rows=${rows%% *}
    [[ $rows =~ ^[0-9]+$ ]] && ((rows > 4)) || rows=24
    printf '\e[H\e[2J\e[3;%dr' "$rows"
    stream_display "$title" "$pat" "$rows"
    while :; do
        if read_key 0.3; then
            case $KEY in
                ESC|q) mode=back; break ;;
                SPACE|ENTER|UP|DOWN|PGUP|PGDN|HOME|END) mode=browse; break ;;
                "&"|/|L)
                    stop_display
                    t livepat_p
                    if read_line newpat "$S" "$pat" 2; then pat=$newpat; fi
                    stream_display "$title" "$pat" "$rows" ;;
                S) save_stream "${STREAM_SLUG:-stream}" ;;
            esac
            continue
        fi
        ((INT_HIT)) && { mode=browse; break; }
        if ((ended == 0)) && ! producers_alive; then
            ended=1
            sleep 0.3
            [[ -n $sumfn ]] && "$sumfn"
            t stream_end; printf '\e[33m%s\e[0m\n' "$S"
        fi
    done
    stop_display
    printf '\e[r\e[%d;1H' "$rows"
    if [[ $mode == browse ]]; then
        if ((HAVE_LESS)); then
            trap ':' INT
            t less_p
            less -R -i +G "${LESSKEY_OPT[@]}" -Ps"${title//./\\.} -- $S" "$TMP/log"
        else
            t noless; printf '\n%s' "$S"; IFS= read -r _
        fi
    fi
    stop_producers
    trap 'exit 130' INT
    enter_screen
}

# ---------------------------------------------------------------- logs
view_logs() {   # view_logs POD-INDEX [PATTERN] [prev|ctr=NAME]
    local i=$1 pat=$2 mode=$3 ns=${P_NS[i]} name=${P_NAME[i]} total=${P_READY[i]#*/} title
    local args=(logs "$name" -n "$ns" "--tail=$TAIL" -f)
    t logs; title="$S $ns/$name"
    case $mode in
        prev) args+=(--previous); t logs_prev; title="$S $ns/$name" ;;
        ctr=*) args+=(-c "${mode#ctr=}"); title+=" (${mode#ctr=})" ;;
        *)  if [[ $total =~ ^[0-9]+$ ]] && ((total > 1)); then
                args+=(--all-containers=true --prefix=true); ((total > 5)) && args+=("--max-log-requests=$total")
            fi ;;
    esac
    : >"$TMP/log"
    PFXMAP=""; STREAM_SLUG="$ns-$name${mode:+-${mode#ctr=}}"
    producer kc "${args[@]}"
    COLORIZE=logs
    stream_view "$title" "$pat"
}
view_logs_multi() {   # view_logs_multi PATTERN INDEX...  : one screen, [ns/pod/container] prefixes, one kubectl per pod
    local pat=$1 i ns name total n; shift
    n=$#
    : >"$TMP/log"
    PFXMAP=""                                   # kubectl --prefix writes [pod/NAME/CTR]; the colorizer shows [NS/NAME/CTR] using this map
    for i in "$@"; do
        ns=${P_NS[i]}; name=${P_NAME[i]}; total=${P_READY[i]#*/}
        local args=(logs "$name" -n "$ns" "--tail=$TAIL" -f --all-containers=true --prefix=true)
        [[ $total =~ ^[0-9]+$ ]] && ((total > 5)) && args+=("--max-log-requests=$total")
        producer kc "${args[@]}"
        PFXMAP+="$name=$ns,"
    done
    t multilogs; printf -v S "$S" "$n"
    COLORIZE=logs; STREAM_SLUG="multi-$n"
    stream_view "$S" "$pat"
}
logs_under_row() {   # L on a group row: every pod below it, asks for a pattern first (empty = all lines)
    local pat
    pods_under "$SEL"
    ((${#UNDER[@]})) || { t selpod; MSG=$S; return; }
    t logpat_p
    read_line pat "$S" || return
    if ((${#UNDER[@]} == 1)); then view_logs "${UNDER[0]}" "$pat"; else view_logs_multi "$pat" "${UNDER[@]}"; fi
}
logs_marked() {
    local idx=() i
    for ((i = 0; i < NPODS; i++)); do [[ -n ${MARK[${P_NS[i]}/${P_NAME[i]}]+x} ]] && idx+=("$i"); done
    ((${#idx[@]})) || { t nomarked; MSG=$S; return; }
    if ((${#idx[@]} == 1)); then view_logs "${idx[0]}"; else view_logs_multi "" "${idx[@]}"; fi
}

# ---------------------------------------------------------------- events
events_of() {   # events_of NS NAME-SUBSTRING : namespace events whose object column mentions the name (workload rows)
    kc get events -n "$1" --sort-by=.lastTimestamp 2>&1 | awk -v n="$2" 'NR == 1 || index($0, n)'
}
view_events() {
    local kind=${R_KIND[SEL]} key=${R_KEY[SEL]} i=${R_IDX[SEL]} ns
    t events
    case $kind in
        pod)  pager "$S ${P_NS[i]}/${P_NAME[i]}" kc get events -n "${P_NS[i]}" --field-selector "involvedObject.name=${P_NAME[i]},involvedObject.kind=Pod" --sort-by=.lastTimestamp ;;
        node) [[ $key == "node:~" ]] && { t notnode; MSG=$S; return; }
              pager "$S node ${key#node:}" kc get events -A --field-selector "involvedObject.kind=Node,involvedObject.name=${key#node:}" --sort-by=.lastTimestamp ;;
        ns)   ns=${key#ns:}; ns=${ns##*/}; pager "$S namespace $ns" kc get events -n "$ns" --sort-by=.lastTimestamp ;;
        wl)   ns=${key#wl:}; ns=${ns%%/*}; pager "$S ${key#wl:}" events_of "$ns" "${key##*/}" ;;
        *) return ;;
    esac
}
live_events() {
    : >"$TMP/log"
    if [[ -n $NS ]]; then producer kc get events -n "$NS" --field-selector type=Warning -w
    else producer kc get events -A --field-selector type=Warning -w; fi
    COLORIZE=logs; STREAM_SLUG="events"
    t events_live; stream_view "$S${NS:+ $NS}" ""
}

# ---------------------------------------------------------------- relations (services / endpoints / ingress / netpol / volumes)
cat >"$TMP/rel.awk" <<'EOF'
BEGIN {
    FS = "\t"
    n = split(labels, la, ","); for (i = 1; i <= n; i++) if (la[i] != "") { split(la[i], kv, "="); L[kv[1]] = kv[2] }
    n = split(vols, va, ","); for (i = 1; i <= n; i++) if (va[i] != "") { split(va[i], kv, ":"); V[kv[1] ":" kv[2]] = 1; if (kv[1] == "pvc") PV[kv[2]] = 1 }
}
{ gsub(/<no value>/, "") }
$1 == "Service" { svc[$2] = 1; stype[$2] = $3; sip[$2] = $4; sports[$2] = $5; ssel[$2] = $6; slb[$2] = $7 }
$1 == "Endpoints" { epr[$2] = $3; epn[$2] = $4 }
$1 == "PersistentVolumeClaim" { pvc[$2] = $3; pvv[$2] = $4; pvcap[$2] = $5; pvsc[$2] = $6; pvam[$2] = $7 }
$1 == "Ingress" { ing[$2] = 1; icls[$2] = $3; irules[$2] = $4; ilb[$2] = $5; idef[$2] = $6 }
$1 == "NetworkPolicy" { np[$2] = 1; npsel[$2] = $3; npexp[$2] = $4; nptypes[$2] = $5; npi[$2] = length($6); npe[$2] = length($7) }
function cnt(s,   a, k) { if (s == "") return 0; k = split(s, a, ","); return k - 1 }
function selmatch(sel,   a, i, k, kv) {
    if (sel == "") return 0
    k = split(sel, a, ",")
    for (i = 1; i <= k; i++) if (a[i] != "") { split(a[i], kv, "="); if (!(kv[1] in L) || L[kv[1]] != kv[2]) return 0 }
    return 1
}
END {
    all = (name == "")
    if (!all) { print "POD " ns "/" name "   ip " (ip == "" ? "-" : ip); print "LABELS " labels; print "" }
    print (all ? "SERVICES in " ns : "SERVICES selecting this pod") "                      (endpoints: ready / not ready)"
    found = 0
    for (s in svc) {
        if (!all && !selmatch(ssel[s])) continue
        found = 1; sel[s] = 1
        st = "";
        if (!all && ip != "") {
            if (index("," epr[s], "," ip "=")) st = "  <- THIS POD IS IN ROTATION"
            else if (index("," epn[s], "," ip "=")) st = "  <- THIS POD IS NOT READY (out of rotation)"
            else st = "  <- this pod is not in the endpoints"
        }
        printf "  %-28s %-12s %-16s %-28s ready %d / not ready %d%s%s\n", s, stype[s], sip[s], sports[s], cnt(epr[s]), cnt(epn[s]), (slb[s] != "" ? "  lb " slb[s] : ""), st
        if (all && (ssel[s] == "")) printf "  %-28s (no selector: external / headless endpoints)\n", ""
        if (!all && cnt(epn[s]) > 0) printf "  %-28s not ready: %s\n", "", epn[s]
    }
    if (!found) print "  (none)"
    print ""; print "INGRESS -> " (all ? "services in " ns : "these services")
    found = 0
    for (g in ing) {
        k = split(irules[g], ra, ";")
        for (i = 1; i <= k; i++) {
            if (ra[i] == "") continue
            host = ra[i]; sub(/\[.*/, "", host); paths = ra[i]; sub(/^[^[]*\[/, "", paths); sub(/\]$/, "", paths)
            m = split(paths, pa, ",")
            for (j = 1; j <= m; j++) {
                if (pa[j] == "") continue
                split(pa[j], pb, ">"); split(pb[2], sv, ":")
                if (all || (sv[1] in sel)) { found = 1; printf "  %-28s host %-30s %-12s -> %-24s class %s%s\n", g, (host == "" ? "*" : host), pb[1], pb[2], (icls[g] == "" ? "-" : icls[g]), (ilb[g] != "" ? "  lb " ilb[g] : "") }
            }
        }
        if (idef[g] != "" && (all || (idef[g] in sel))) { found = 1; printf "  %-28s default backend -> %s\n", g, idef[g] }
    }
    if (!found) print "  (none)"
    print ""; print "NETWORK POLICIES " (all ? "in " ns : "applying to this pod")
    found = 0
    for (p in np) {
        if (npexp[p] != "") how = "matchExpressions " npexp[p] " (check manually)"
        else if (npsel[p] == "") how = "all pods in the namespace"
        else { if (!all && !selmatch(npsel[p])) continue; how = "selector " npsel[p] }
        found = 1
        printf "  %-28s types %-16s ingress rules %d   egress rules %d   %s\n", p, (nptypes[p] == "" ? "Ingress" : nptypes[p]), npi[p], npe[p], how
    }
    if (!found) print "  (none)"
    print ""; print "VOLUMES" (all ? " (PVCs in " ns ")" : "")
    found = 0
    for (v in pvc) {
        if (!all && !(v in PV)) continue
        found = 1
        printf "  pvc %-24s %-10s %-8s %-12s %-8s pv %s\n", v, pvc[v], pvcap[v], pvsc[v], pvam[v], pvv[v]
    }
    if (!all) for (v in V) if (v !~ /^pvc:/) { found = 1; print "  " v }
    if (!found) print "  (none)"
}
EOF
view_relations() {
    local kind=${R_KIND[SEL]} key=${R_KEY[SEL]} i=${R_IDX[SEL]} ns name="" labels="" ip="" vols=""
    case $kind in
        pod) ns=${P_NS[i]}; name=${P_NAME[i]}; labels=${P_LABELS[i]}; ip=${P_IP[i]}; vols=${P_VOLS[i]} ;;
        ns)  ns=${key#ns:}; ns=${ns##*/} ;;
        wl)  ns=${key#wl:}; ns=${ns%%/*} ;;
        node) node_report "${key#node:}"; return ;;
        *) return ;;
    esac
    t rel; local title="$S ${name:+$ns/}${name:-$ns}"
    MSG="$title ..."; draw; MSG=""
    kc get svc,endpoints,pvc -n "$ns" -o go-template="$REL_CORE" >"$TMP/rel.core" 2>"$TMP/rel.err"
    kc get ingress,networkpolicy -n "$ns" -o go-template="$REL_NET" >"$TMP/rel.net" 2>>"$TMP/rel.err"
    { awk -v ns="$ns" -v name="$name" -v labels="$labels" -v ip="$ip" -v vols="$vols" -f "$TMP/rel.awk" "$TMP/rel.core" "$TMP/rel.net"
      [[ -s $TMP/rel.err ]] && { echo; echo "kubectl:"; cat "$TMP/rel.err"; }; } >"$TMP/rel.txt" 2>&1
    pager_file "$title" "$TMP/rel.txt"
}
node_report() {
    local node=$1 i n=0 os rt kern created
    [[ $node == "~" ]] && { t notnode; MSG=$S; return; }
    IFS=';' read -r os rt kern created <<<"${NODE_MISC[$node]}"
    {   echo "NODE $node   ${NODEINFO[$node]}"
        echo "addresses   ${NODE_ADDR[$node]%,}"; echo "podCIDR     ${NODE_CIDR[$node]:--}"
        echo "allocatable ${NODE_ALLOC[$node]}   capacity ${NODE_CAP[$node]}   (pods;cpu;memory)"
        echo "taints      ${NODE_TAINT[$node]:-(none)}"; echo "pressure    ${NODE_COND[$node]:-(none)}"
        echo "requests    cpu ${NODE_RQC[$node]:--}%  memory ${NODE_RQM[$node]:--}%  of allocatable${TOPN_CPU[$node]:+   usage cpu ${TOPN_CPU[$node]}  memory ${TOPN_MEM[$node]}}"
        echo "os $os   runtime $rt   kernel $kern   created $created"
        echo; echo "PODS ON THIS NODE"
        for ((i = 0; i < NPODS; i++)); do
            [[ ${P_NODE[i]} == "$node" ]] || continue
            printf '  %-40s %-7s %-20s %-4s %-8s %s\n' "${P_NS[i]}/${P_NAME[i]}" "${P_READY[i]}" "${P_STATUS[i]}" "${P_RESTARTS[i]}" "${P_IP[i]:--}" "${P_HOSTNET[i]:+hostNetwork}"
            ((n++))
        done
        echo "  $n pods"
    } >"$TMP/rel.txt"
    t rel; pager_file "$S node $node" "$TMP/rel.txt"
}

# ---------------------------------------------------------------- probes: /proc + cgroup snapshot (pod via exec, this host, or ssh)
PROBE='cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; echo "=SOCK"; cat /proc/net/sockstat 2>/dev/null; echo "=SNMP"; cat /proc/net/snmp 2>/dev/null
echo "=NETSTAT"; cat /proc/net/netstat 2>/dev/null; echo "=DEV"; cat /proc/net/dev 2>/dev/null
echo "=CT"; cat /proc/sys/net/netfilter/nf_conntrack_count /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null
echo "=FD"; for p in /proc/[0-9]*; do n=$(ls "$p/fd" 2>/dev/null | wc -l); [ "$n" -gt 0 ] || continue; c=$(tr "\0" " " < "$p/cmdline" 2>/dev/null | head -c 40 | sed -n "s/^nginx: \([a-z]*\).*/nginx:\1/p"); [ -n "$c" ] || c=$(cat "$p/comm" 2>/dev/null); echo "$n $c $(sed -n "s/^Max open files *\([0-9]*\) *\([0-9]*\).*/\1 \2/p" "$p/limits" 2>/dev/null)"; done 2>/dev/null | sort -rn
echo "=FNR"; cat /proc/sys/fs/file-nr 2>/dev/null
echo "=MEM"; cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.usage_in_bytes /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null
echo "=CPU"; grep usage_usec /sys/fs/cgroup/cpu.stat 2>/dev/null || cat /sys/fs/cgroup/cpuacct/cpuacct.usage 2>/dev/null; cat /sys/fs/cgroup/cpu.max 2>/dev/null || cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us /sys/fs/cgroup/cpu/cpu.cfs_period_us 2>/dev/null
echo "=LOAD"; cat /proc/loadavg 2>/dev/null; echo "=MEMINFO"; head -3 /proc/meminfo 2>/dev/null; echo "=STAT"; head -1 /proc/stat 2>/dev/null; echo "=END"'
cat >"$TMP/net.awk" <<'EOF'
# two snapshots (prev, cur) -> report lines.  -v dt=SECONDS -v mode=pod|host -v title=...
function hexip(h,   a, b, c, d) { if (length(h) != 8) return "v6:" substr(h, length(h) - 7); a = strtonum0(substr(h, 7, 2)); b = strtonum0(substr(h, 5, 2)); c = strtonum0(substr(h, 3, 2)); d = strtonum0(substr(h, 1, 2)); return a "." b "." c "." d }
function strtonum0(h,   i, v, c) { v = 0; h = tolower(h); for (i = 1; i <= length(h); i++) { c = index("0123456789abcdef", substr(h, i, 1)) - 1; v = v * 16 + c }; return v }
function human(b) { if (b >= 1073741824) return sprintf("%.1fG", b / 1073741824); if (b >= 1048576) return sprintf("%.1fM", b / 1048576); if (b >= 1024) return sprintf("%.0fK", b / 1024); return b "" }
function d(k) { return (k in cur) && (k in prev) ? cur[k] - prev[k] : 0 }
FNR == 1 { file++; sec = "TCP" }
/^=[A-Z]+$/ { sec = substr($0, 2); next }
{
    if (sec == "TCP" && $1 ~ /^[0-9]+:$/) {
        st = $4
        if (file == 1) S1[st]++
        else {
            S[st]++
            if (st == "0A") {     # listening socket: tx_queue = backlog size, rx_queue = connections waiting for accept()
                split($2, la, ":"); lp = strtonum0(la[2]); split($5, qq, ":"); bl = strtonum0(qq[1]); rq = strtonum0(qq[2])
                LP[lp] = 1; LN[lp]++; LQ[lp] += rq; if (rq > LMAX[lp]) LMAX[lp] = rq; if (bl > LB[lp]) LB[lp] = bl; if (rq > 0) LSTUCK[lp]++
                if (rq > lqmax) lqmax = rq; lqsum += rq; if (bl > 0 && rq >= bl) lfull++
            }
            if (st == "01") { split($3, ra, ":"); P[hexip(ra[1])]++ }
        }
    }
    if (sec == "SOCK") { if (file == 2) sock = sock " " $0 }
    if (sec == "SNMP" || sec == "NETSTAT") {
        if ($1 == "Tcp:" || $1 == "TcpExt:" || $1 == "Ip:") {
            if (!(hdrseen[file, $1])) { hdrseen[file, $1] = 1; for (i = 2; i <= NF; i++) hn[$1, i] = $i }
            else for (i = 2; i <= NF; i++) { if (file == 1) prev[$1 hn[$1, i]] = $i; else cur[$1 hn[$1, i]] = $i }
        }
    }
    if (sec == "DEV" && $0 ~ /:/ && $1 !~ /^lo:/) {
        line = $0; sub(/^ */, "", line); split(line, a, ":"); ifn = a[1]; nf2 = split(a[2], f, " ")
        if (file == 1) { prx[ifn] = f[1]; ptx[ifn] = f[9] } else { crx[ifn] = f[1]; ctx[ifn] = f[9]; rerr[ifn] = f[3] + f[4]; terr[ifn] = f[11] + f[12]; IF[ifn] = 1 }
    }
    if (sec == "CT" && file == 2) { if (ctc == "") ctc = $1; else ctm = $1 }
    if (sec == "FD" && $1 ~ /^[0-9]+$/) {          # "count name soft hard" per process, largest first (nginx:master / nginx:worker)
        if (file == 1) { if (fdtop1 == "") fdtop1 = $1 }
        else {
            fdsum += $1; fdprocs++
            if ($2 == "nginx:worker") nginxw++; else if ($2 == "nginx:master") nginxm++
            if (fdtop == "") { fdtop = $1; fdname = $2; fdlim = $3; fdhard = $4 }
            if (fdprocs <= 3) fdlist = fdlist (fdlist == "" ? "" : ", ") $2 " " $1 "/" ($3 == "" ? "?" : $3) (($4 != "" && $4 != $3) ? " (hard " $4 ")" : "")
        }
    }
    if (sec == "FNR" && file == 2 && NF == 3) fnr = $1 " / " $3
    if (sec == "MEM" && file == 2) { if (memc == "") memc = $1; else memm = $1 }
    if (sec == "CPU") {
        if ($1 == "usage_usec") { if (file == 1) pcpu = $2; else ccpu = $2 }
        else if (NF == 1 && $1 ~ /^[0-9]+$/ && cpuq == "" && cpuseen[file]++ == 0) { if (file == 1) pcpu = $1 / 1000; else ccpu = $1 / 1000 }
        else if (NF == 2 && file == 2) { cpuq = $1; cpup = $2 }
        else if (NF == 1 && file == 2 && $1 ~ /^-?[0-9]+$/ && cpuseen[file] > 0) { if (cpuq == "") cpuq = $1; else cpup = $1 }
    }
    if (sec == "LOAD" && file == 2) load = $1 " " $2 " " $3
    if (sec == "MEMINFO" && file == 2) { if ($1 == "MemTotal:") mt = $2; if ($1 == "MemAvailable:") ma = $2 }
    if (sec == "STAT" && $1 == "cpu") { tot = 0; for (i = 2; i <= NF; i++) tot += $i; if (file == 1) { ptot = tot; pidle = $5 } else { ctot = tot; cidle = $5 } }
}
END {
    if (compact) {   # one compact sample line: value(delta since the previous sample); [!] / [!!] when drop counters moved
        flag = ""
        fdpct = (fdlim ~ /^[0-9]+$/ && fdlim > 0) ? fdtop * 100 / fdlim : 0
        fdalarm = (fdpct >= 95) || (fdpct >= 80 && fdtop1 != "" && fdtop > fdtop1)     # near the limit AND still growing (a static 88% is shown, not flagged)
        if (d("TcpExt:ListenOverflows") > 0 || d("TcpExt:ListenDrops") > 0 || fdalarm || lfull > 0) flag = "[!!] "
        else if (d("TcpExt:TCPSynRetrans") > 0 || d("Tcp:RetransSegs") > 0 || d("Tcp:OutRsts") > 0 || S["03"] > S1["03"] || lqmax >= 16) flag = "[!] "
        cpus = (ccpu != "" && pcpu != "") ? sprintf("cpu %.0f%%", (ccpu - pcpu) / (dt * 1000000) * 100) : ((ctot != "" && ctot > ptot) ? sprintf("hostcpu %.0f%%", 100 - (cidle - pidle) * 100 / (ctot - ptot)) : "cpu -")
        mems = (memc != "") ? "mem " human(memc) ((memm ~ /^[0-9]+$/ && memm < 9e18) ? "/" human(memm) : "") : (mt != "" ? "memavail " human(ma * 1024) : "mem -")
        nic = ""; for (i in IF) nic = nic sprintf(" %s rx %s/s tx %s/s", i, human((crx[i] - prx[i]) / dt), human((ctx[i] - ptx[i]) / dt))
        lstuck = 0; for (p in LSTUCK) lstuck += LSTUCK[p]
        lq = sprintf("lq %d", lqsum); if (lqmax > 0) lq = lq sprintf(" max %d on %d sock", lqmax, lstuck); if (lfull > 0) lq = lq sprintf(" FULL %d", lfull)
        wk = (nginxw > 0) ? sprintf(" | nginx w%d%s", nginxw, (nginxm > 1 ? " m" nginxm : "")) : ""
        printf "%s%s  ESTAB %d(%+d) SYN_RECV %d(%+d) TIME_WAIT %d(%+d) CLOSE_WAIT %d(%+d) | %s | ovf %+d drop %+d synretr %+d retr %+d rst %+d fail %+d | ct %s%s | fd %s%s | %s | %s |%s\n", flag, ts, S["01"], S["01"] - S1["01"], S["03"], S["03"] - S1["03"], S["06"], S["06"] - S1["06"], S["08"], S["08"] - S1["08"], lq, d("TcpExt:ListenOverflows"), d("TcpExt:ListenDrops"), d("TcpExt:TCPSynRetrans"), d("Tcp:RetransSegs"), d("Tcp:OutRsts"), d("Tcp:AttemptFails"), (ctc == "" ? "-" : ctc), (ctm == "" ? "" : "/" ctm), (fdprocs ? fdsum " (" fdname " " fdtop "/" (fdlim == "" ? "?" : fdlim) (fdpct >= 50 ? sprintf(" %.0f%%", fdpct) : "") ")" : "-"), wk, mems, cpus, nic
        exit
    }
    printf "TCP states    ESTAB %-6d SYN_SENT %-4d SYN_RECV %-4d TIME_WAIT %-6d CLOSE_WAIT %-5d FIN_WAIT %-4d LAST_ACK %-3d LISTEN %d\n", S["01"], S["02"], S["03"], S["06"], S["08"], S["04"] + S["05"], S["09"], S["0A"]
    for (p in LP) printf "LISTEN :%-6d sockets %-4d backlog %-6d queued now %-5d busiest %-5d sockets with a queue %d%s\n", p, LN[p], LB[p], LQ[p], LMAX[p], LSTUCK[p], (LB[p] > 0 && LMAX[p] >= LB[p]) ? "   <- FULL: new connections are being dropped" : ""
    if (nginxw > 0 || nginxm > 0) printf "nginx         workers %d   master %d%s\n", nginxw, nginxm, (nginxm > 1 ? "   (more than one master: reload / old workers still draining)" : "")
    printf "sockstat     %s\n", sock
    printf "TCP counters  (delta / %ss)  ListenOverflows %+d  ListenDrops %+d  SynRetrans %+d  RetransSegs %+d  OutRsts %+d  AttemptFails %+d  EstabResets %+d  InErrs %+d  ActiveOpens %+d  PassiveOpens %+d\n", dt, d("TcpExt:ListenOverflows"), d("TcpExt:ListenDrops"), d("TcpExt:TCPSynRetrans"), d("Tcp:RetransSegs"), d("Tcp:OutRsts"), d("Tcp:AttemptFails"), d("Tcp:EstabResets"), d("Tcp:InErrs"), d("Tcp:ActiveOpens"), d("Tcp:PassiveOpens")
    printf "TCP memory    PruneCalled %+d  RcvPruned %+d  TCPMemoryPressures %+d  TCPTimeouts %+d  TCPAbortOnTimeout %+d  OFOQueue %+d\n", d("TcpExt:PruneCalled"), d("TcpExt:RcvPruned"), d("TcpExt:TCPMemoryPressures"), d("TcpExt:TCPTimeouts"), d("TcpExt:TCPAbortOnTimeout"), d("TcpExt:TCPOFOQueue")
    if (ctm != "") printf "conntrack     %s / %s  (%.1f%%)%s\n", ctc, ctm, ctc * 100 / ctm, (mode == "pod" ? "   (node-wide value seen from the pod)" : ""); else print "conntrack     (not available)"
    for (i in IF) printf "NIC %-10s rx %8s/s  tx %8s/s   rx errs+drop %d  tx errs+drop %d\n", i, human((crx[i] - prx[i]) / dt), human((ctx[i] - ptx[i]) / dt), rerr[i], terr[i]
    if (fdprocs) printf "FDs           %d open in %d processes   most: %s   (count/limit)   file-nr %s\n", fdsum, fdprocs, fdlist, (fnr == "" ? "-" : fnr); else printf "FDs           (not readable)   file-nr %s\n", (fnr == "" ? "-" : fnr)
    if (memc != "") { lim = (memm ~ /^[0-9]+$/ && memm < 9e18) ? human(memm) " (" sprintf("%.0f", memc * 100 / memm) "%)" : "no limit"; printf "cgroup mem    %s / %s\n", human(memc), lim } else print "cgroup mem    (not available)"
    if (ccpu != "" && pcpu != "") { pct = (ccpu - pcpu) / (dt * 1000000) * 100; q = (cpuq ~ /^[0-9]+$/ && cpup > 0) ? sprintf("limit %.2f cpu (%.0f%% of limit)", cpuq / cpup, pct / (cpuq / cpup)) : "no limit"; printf "cgroup cpu    %.1f%% of one core   %s\n", pct, q }
    if (ctot != "" && ptot != "" && ctot > ptot) printf "host cpu      %.1f%% busy   load %s   mem avail %s / %s\n", 100 - (cidle - pidle) * 100 / (ctot - ptot), load, human(ma * 1024), human(mt * 1024); else if (load != "") printf "host load     %s\n", load
    n = 0; top = ""; for (p in P) n++
    for (k = 0; k < 6 && n > 0; k++) { best = ""; bv = -1; for (p in P) if (P[p] > bv) { bv = P[p]; best = p }; if (best == "") break; top = top " " best "(" bv ")"; delete P[best]; n-- }
    if (top != "") printf "top peers     established connections by remote ip:%s\n", top
}
EOF
probe_run() {
    ((READONLY)) && { t readonly; MSG=$S; return 126; }
   # probe_run TARGET(pod INDEX | host | ssh:NODE) OUTFILE ; returns kubectl / ssh rc
    local tgt=$1 out=$2
    case $tgt in
        host) sh -c "$PROBE" >"$out" 2>/dev/null ;;
        ssh:*) ssh_host "${tgt#ssh:}"; ssh -o BatchMode=yes -o ConnectTimeout=5 "$SSH_HOST" sh <<<"$PROBE" >"$out" 2>/dev/null ;;
        *) kc exec "${P_NAME[tgt]}" -n "${P_NS[tgt]}" -c "$PROBE_CTR" -- sh -c "$PROBE" >"$out" 2>/dev/null ;;
    esac
}
ssh_host() { if [[ $SSH_TPL == *%h* ]]; then SSH_HOST=${SSH_TPL//%h/$1}; else SSH_HOST="$SSH_TPL$1"; fi; }
is_local_node() { [[ $1 == "$LOCAL_NODE" || $1 == "$HOSTNAME" || $1 == "${HOSTNAME%%.*}" ]]; }

net_producer() {   # background: a detail block first, then one compact line per sample (deltas vs the previous sample); block again every 30 samples
    local tgt=$1 mode=$2 dt=$3 n=0 ts
    probe_run "$tgt" "$TMP/np.prev" && grep -q '^=END' "$TMP/np.prev" || { echo "[!!] probe failed (no sh or /proc in the container?)"; return 1; }
    awk -v dt="$dt" -v mode="$mode" -f "$TMP/net.awk" "$TMP/np.prev" "$TMP/np.prev"
    echo "---- every ${dt}s: value(delta)   [!] retransmits / resets / SYN backlog grew   [!!] listen queue overflow or drop"
    while :; do
        sleep "$dt"
        probe_run "$tgt" "$TMP/np.cur" && grep -q '^=END' "$TMP/np.cur" || { echo "[!!] probe failed"; return 1; }
        printf -v ts '%(%H:%M:%S)T' -1 2>/dev/null || ts=$(date +%H:%M:%S)
        awk -v compact=1 -v ts="$ts" -v dt="$dt" -v mode="$mode" -f "$TMP/net.awk" "$TMP/np.prev" "$TMP/np.cur"
        if ((++n % 30 == 0)); then echo "----"; awk -v dt="$dt" -v mode="$mode" -f "$TMP/net.awk" "$TMP/np.prev" "$TMP/np.cur"; echo "----"; fi
        mv -f "$TMP/np.cur" "$TMP/np.prev"
    done
}
view_netstat() {
    ((READONLY)) && { t readonly; MSG=$S; return 126; }
    confirm "network probe (exec / SSH): context=$CTX target=${R_KEY[SEL]:-none}. Continue? [y/N]" || return
   # N: network / resource samples of the selected pod (or this host / a node), accumulating like a log
    local kind=${R_KIND[SEL]} key=${R_KEY[SEL]} i=${R_IDX[SEL]} tgt title mode=pod node
    case $kind in
        pod) tgt=$i; PROBE_CTR=${P_CNAMES[i]%%,*}; title="${P_NS[i]}/${P_NAME[i]} (${PROBE_CTR})"
             [[ ${P_HOSTNET[i]} == true ]] && is_local_node "${P_NODE[i]}" && { tgt=host; mode=host; title+=" hostNetwork -> this host"; } ;;
        node) node=${key#node:}
              if is_local_node "$node"; then tgt=host; mode=host; title="node $node (this host)"
              elif [[ -n $SSH_TPL && $node != "~" ]]; then tgt="ssh:$node"; mode=host; title="node $node (ssh)"
              else t local_only; printf -v MSG "$S" "$node"; return; fi ;;
        *) t selpod; MSG=$S; return ;;
    esac
    : >"$TMP/log"
    producer net_producer "$tgt" "$mode" 2
    COLORIZE=netstat; STREAM_SLUG="net-${title%% *}"
    t netstat; stream_view "$S $title" ""
}

# ---------------------------------------------------------------- packet capture
tcp_summary() {
    local n syn sa rst fin u
    IFS=$'\t' read -r n syn sa rst fin u < <(awk -f "$TMP/tcpsum.awk" "$TMP/log")
    t tcp_sum; printf -v S "$S" "$n" "$syn" "$sa" "$rst" "$fin" "$u"
    printf '\e[1;36m%s\e[0m\n' "$S"
}
capture() {
    ((READONLY)) && { t readonly; MSG=$S; return 126; }
    confirm "capture / debug (may create a container or use sudo): context=$CTX target=${R_KEY[SEL]:-none}. Continue? [y/N]" || return

    local i=${R_IDX[SEL]} methods=() mlabels=() m ctr node ip bpf="" preset count=200 x hostf
    [[ ${R_KIND[SEL]} == pod ]] || { t selpod; MSG=$S; return; }
    node=${P_NODE[i]}; ip=${P_IP[i]}; ctr=${P_CNAMES[i]%%,*}
    if is_local_node "$node" && command -v tcpdump >/dev/null 2>&1; then methods+=(local); t tcp_m_local; mlabels+=("$S"); fi
    t tcpdump; MSG="$S ..."; draw; MSG=""
    if kc exec "${P_NAME[i]}" -n "${P_NS[i]}" -c "$ctr" -- sh -c 'command -v tcpdump' >/dev/null 2>&1; then methods+=(exec); t tcp_m_exec; mlabels+=("$S"); fi
    if [[ -n $DEBUG_IMAGE ]]; then methods+=(debug); t tcp_m_debug; printf -v x "$S" "$DEBUG_IMAGE"; mlabels+=("$x"); fi
    if [[ -n $SSH_TPL && $node != "~" ]]; then methods+=(ssh); t tcp_m_ssh; printf -v x "$S" "$node"; mlabels+=("$x"); fi
    ((${#methods[@]})) || { t tcp_none; MSG=$S; return; }
    t tcp_method; pick x "$S" "${mlabels[@]}" || return
    m=${methods[PICKED]}
    t tcp_p_hs; local p1=$S; t tcp_p_port; local p2=$S; t tcp_p_host; local p3=$S; t tcp_p_rst; local p4=$S; t tcp_p_all; local p5=$S; t tcp_p_custom; local p6=$S
    t tcp_preset; pick x "$S" "$p1" "$p2" "$p3" "$p4" "$p5" "$p6" || return
    case $PICKED in
        0) bpf='tcp[tcpflags] & (tcp-syn|tcp-rst) != 0' ;;
        1) t tcp_port_p; read_line x "$S" "${P_PORTS[i]%%,*}" || return; bpf="port $x" ;;
        2) t tcp_host_p; read_line x "$S" || return; bpf="host $x" ;;
        3) bpf='tcp[tcpflags] & tcp-rst != 0' ;;
        4) bpf="" ;;
        5) t tcp_bpf_p; read_line x "$S" || return; bpf=$x ;;
    esac
    t tcp_count; printf -v x "$S" "$count"; read_line x "$x" "$count" || return; [[ $x =~ ^[0-9]+$ ]] && count=$x
    hostf=""
    if [[ $m == local || $m == ssh ]] && [[ ${P_HOSTNET[i]} != true && -n $ip ]]; then hostf="host $ip"; fi
    [[ -n $hostf && -n $bpf ]] && bpf="$hostf and ($bpf)"; [[ -n $hostf && -z $bpf ]] && bpf=$hostf
    local cmd=(tcpdump -nn -l -i any -c "$count") sudo=()
    [[ -n $bpf ]] && cmd+=("$bpf")
    [[ $EUID != 0 ]] && command -v sudo >/dev/null 2>&1 && sudo=(sudo -n)
    : >"$TMP/log"
    case $m in
        local) producer "${sudo[@]}" "${cmd[@]}" ;;
        exec)  producer kc exec "${P_NAME[i]}" -n "${P_NS[i]}" -c "$ctr" -- "${cmd[@]}" ;;
        debug) producer kc debug "${P_NAME[i]}" -n "${P_NS[i]}" --quiet -i --image="$DEBUG_IMAGE" --target="$ctr" --profile=netadmin -- "${cmd[@]}" ;;
        ssh)   ssh_host "$node"; producer ssh -o BatchMode=yes "$SSH_HOST" sudo -n "${cmd[@]}" ;;
    esac
    COLORIZE=tcpdump; STREAM_SLUG="tcpdump-${P_NAME[i]}"
    t tcpdump; stream_view "$S ${P_NS[i]}/${P_NAME[i]} [$m] ${bpf:-all}" "" tcp_summary
}

# ---------------------------------------------------------------- port-forward
port_forward() {
    ((READONLY)) && { t readonly; MSG=$S; return 126; }
    confirm "local port-forward: context=$CTX target=${R_KEY[SEL]:-none}. Continue? [y/N]" || return

    local i=${R_IDX[SEL]} spec def
    [[ ${R_KIND[SEL]} == pod ]] || { t selpod; MSG=$S; return; }
    def="8080:${P_PORTS[i]%%,*}"; [[ $def == "8080:" ]] && def="8080:80"
    t pf_p; printf -v S "$S" "$def"
    read_line spec "$S" || return
    [[ -z $spec ]] && spec=$def
    : >"$TMP/log"
    producer kc port-forward -n "${P_NS[i]}" "pod/${P_NAME[i]}" "$spec"
    COLORIZE=none; STREAM_SLUG="pf-${P_NAME[i]}"
    t pf; stream_view "$S ${P_NS[i]}/${P_NAME[i]} $spec  (localhost:${spec%%:*})" ""
}

# ---------------------------------------------------------------- GPU / vLLM monitoring (read-only, no extra runtime)
ai_init() {
    cat >"$TMP/ai-discover.awk" <<'AWK'
BEGIN { FS="\t"; OFS="\037" }
function unquote(s) { return s ~ /^".*"$/ ? substr(s,2,length(s)-2) : s }
{
    gsub(/<no value>/, "")
    for (i=24;i<=28;i++) $i=unquote($i)
    type=tolower($24); hint=tolower($3 " " $16 " " $23)
    if (type=="off") next
    if (type!="vllm" && type!="dcgm") {
        if (hint ~ /dcgm[-_]exporter/) type="dcgm"
        else if (hint ~ /vllm/) type="vllm"
        else next
    }
    if (onlydcgm && type!="dcgm") next
    if (type=="vllm" && ns!="" && $2!=ns) next
    if ($4!="Running") next
    port=$25; path=$26
    if (port=="") port=$27
    if (path=="") path=$28
    if (path=="") path="/metrics"
    ports=""
    if (port!="") ports=port
    else {
        cmd=$23; gsub(/"/,"",cmd)
        if (match(cmd, /--port[= ][0-9]+/)) {
            port=substr(cmd,RSTART,RLENGTH); sub(/^--port[= ]/,"",port); ports=port
        }
        n=split($17,p,","); for (i=1;i<=n;i++) if (p[i]!="") ports=ports (ports!="" ? "," : "") p[i]
        ports=ports (ports!="" ? "," : "") (type=="dcgm" ? "9400" : "8000")
    }
    # Keep metadata delimiters/control bytes out of the terminal and snapshot files.
    gsub(/[\001-\010\013-\037\177]/,"?",path)
    print type,$2,$3,$1,ports,path,$29 "|" $15
}
AWK
    cat >"$TMP/ai-prom.awk" <<'AWK'
# Shared Prometheus text parser. Quoted labels may contain commas, braces or spaces.
function sample(line,   i,c,q,esc,end,tail,n,a,k,v) {
    delete labels; name=""; labeltext=""; value=""
    if (line ~ /^[ \t]*#/ || line ~ /^[ \t]*$/) return 0
    if (!match(line,/^[a-zA-Z_:][a-zA-Z0-9_:]*/)) return 0
    name=substr(line,1,RLENGTH); i=RLENGTH+1
    if (substr(line,i,1)=="{") {
        end=i; q=0; esc=0
        for (++end;end<=length(line);end++) {
            c=substr(line,end,1)
            if (esc) {esc=0;continue}
            if (c=="\\" && q) {esc=1;continue}
            if (c=="\"") q=!q
            if (c=="}" && !q) break
        }
        if (end>length(line)) return 0
        labeltext=substr(line,i+1,end-i-1); i=end+1
        tail=labeltext
        while (match(tail,/^[ \t,]*[a-zA-Z_][a-zA-Z0-9_]*[ \t]*=[ \t]*"/)) {
            k=substr(tail,1,RLENGTH); gsub(/^[ \t,]+|[ \t]*=[ \t]*"$/,"",k)
            tail=substr(tail,RLENGTH+1); v=""; esc=0
            for (n=1;n<=length(tail);n++) {
                c=substr(tail,n,1)
                if (esc) { v=v (c=="n" ? " " : c); esc=0; continue }
                if (c=="\\") {esc=1;continue}
                if (c=="\"") break
                v=v c
            }
            gsub(/[\001-\037\177]/,"?",v); labels[k]=v; tail=substr(tail,n+1)
        }
    }
    tail=substr(line,i); sub(/^[ \t]+/,"",tail); split(tail,a,/[ \t]+/); value=a[1]
    return value ~ /^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$/
}
AWK
    cat >"$TMP/ai-vllm.awk" <<'AWK'
BEGIN { OFS="\037" }
function metric(n) {
    if (n=="vllm:num_requests_running") return "run"
    if (n=="vllm:num_requests_waiting") return "wait"
    if (n=="vllm:kv_cache_usage_perc" || n=="vllm:gpu_cache_usage_perc") return "kv"
    if (n=="vllm:request_success_total") return "done"
    if (n=="vllm:prompt_tokens_total") return "input"
    if (n=="vllm:generation_tokens_total") return "output"
    if (n=="vllm:time_to_first_token_seconds_sum") return "ttfts"
    if (n=="vllm:time_to_first_token_seconds_count") return "ttftn"
    if (n=="vllm:e2e_request_latency_seconds_sum") return "e2es"
    if (n=="vllm:e2e_request_latency_seconds_count") return "e2en"
    if (n=="vllm:request_queue_time_seconds_sum") return "queues"
    if (n=="vllm:request_queue_time_seconds_count") return "queuen"
    return ""
}
function gauge(g,m) { return ((1 SUBSEP g SUBSEP m) in present) ? sprintf("%.3f",total[1,g,m]) : "N/A" }
function delta(g,m,   k,a,n,d) {
    if (identity[0]!=identity[1] || stamp[1]<=stamp[0] || starts[0]!=starts[1]) return "N/A"
    if (!((1 SUBSEP g SUBSEP m) in present) || present[0,g,m]!=present[1,g,m]) return "N/A"
    d=0
    for (k in series) {
        split(k,a,SUBSEP)
        if (a[1]!=1 || a[2]!=g || a[3]!=m) continue
        n=0 SUBSEP g SUBSEP m SUBSEP a[4]
        if (!(n in series) || series[k]<series[n]) return "N/A"
        d+=series[k]-series[n]
    }
    return d
}
function rate(g,m,   d) { d=delta(g,m); return d=="N/A" ? d : sprintf("%.1f",d/(stamp[1]-stamp[0])) }
function latency(g,m,   s,n) { s=delta(g,m "s"); n=delta(g,m "n"); return s=="N/A" || n=="N/A" || n<=0 ? "N/A" : sprintf("%.3f",s/n) }
function emit(g,kind,model,   d,k) {
    d=delta(g,"done"); k=gauge(g,"kv")
    print kind,model,gauge(g,"run"),gauge(g,"wait"),(k=="N/A" ? k : sprintf("%.1f",k*100)),gauge(g,"done"),(d=="N/A" ? d : sprintf("%.0f",d)),rate(g,"input"),rate(g,"output"),latency(g,"ttft"),latency(g,"e2e"),latency(g,"queue"),(stamp[0]>0 ? stamp[1]-stamp[0] : 0)
}
{
    stage=(FILENAME==ARGV[1] ? 0 : 1)
    if ($0 ~ /^# podtree-id /) {identity[stage]=substr($0,14);next}
    if ($0 ~ /^# podtree-time /) {stamp[stage]=substr($0,16)+0;next}
    if (!sample($0)) next
    if (name=="process_start_time_seconds") {starts[stage]=value;next}
    m=metric(name); if (m=="" || value<0) next
    model=labels["model_name"]; if (model=="") model="(model label unavailable)"
    if (stage==1) models[model]=1
    # Prefer the newer cache name when both versions are exposed; never add ratios.
    if (m=="kv" && name=="vllm:gpu_cache_usage_perc") {if (!((stage SUBSEP model) in oldkv) || value>oldkv[stage,model]) oldkv[stage,model]=value}
    else {
        for (j=0;j<2;j++) {
            g=(j ? "M:" model : "A")
            key=stage SUBSEP g SUBSEP m SUBSEP labeltext
            if (key in series) continue
            series[key]=value+0; present[stage,g,m]++
            if (m=="kv") {if (value>total[stage,g,m]) total[stage,g,m]=value}
            else total[stage,g,m]+=value
        }
    }
}
END {
    for (k in oldkv) {
        split(k,a,SUBSEP); g="M:" a[2]
        if (!((a[1] SUBSEP g SUBSEP "kv") in present)) {present[a[1],g,"kv"]=1; total[a[1],g,"kv"]=oldkv[k]}
        if (total[a[1],g,"kv"]>total[a[1],"A","kv"]) total[a[1],"A","kv"]=total[a[1],g,"kv"]
        present[a[1],"A","kv"]=1
    }
    if (!(1 SUBSEP "A" SUBSEP "run" in present) && !(1 SUBSEP "A" SUBSEP "done" in present)) exit 2
    emit("A","A","all models")
    for (model in models) emit("M:" model,"M",model)
}
AWK
    cat >"$TMP/ai-gpu.awk" <<'AWK'
BEGIN { OFS="\037" }
{
    if (!sample($0) || name !~ /^DCGM_FI_/ || value<0 || value>1e12) next
    if (name !~ /^DCGM_FI_DEV_(GPU_UTIL|FB_USED|FB_FREE|GPU_TEMP|POWER_USAGE)$/) next
    uuid=labels["UUID"]; if (uuid=="") uuid=labels["gpu"]
    if (uuid=="") next
    mig=labels["GPU_I_ID"]; key=uuid (mig!="" ? "/MIG-" mig : "")
    ids[key]=1; gpu[key]=labels["gpu"] (mig!="" ? "/MIG-" mig : ""); if(labels["modelName"]!="") model[key]=labels["modelName"]
    vals[key,name]=value
    p=labels["pod"]; ns=labels["namespace"]
    if (p!="" && ns!="") maps[key,ns "/" p]=1
}
function val(k,n) { return ((k SUBSEP n) in vals) ? vals[k,n] : "N/A" }
END {
    for (k in ids) {
        u=val(k,"DCGM_FI_DEV_FB_USED"); f=val(k,"DCGM_FI_DEV_FB_FREE"); list=""
        for (m in maps) {split(m,a,SUBSEP);if(a[1]==k) list=list (list!="" ? "," : "") a[2]}
        print node,k,gpu[k],model[k],val(k,"DCGM_FI_DEV_GPU_UTIL"),u,(u!="N/A" && f!="N/A" ? sprintf("%.0f",u+f) : "N/A"),val(k,"DCGM_FI_DEV_GPU_TEMP"),val(k,"DCGM_FI_DEV_POWER_USAGE"),list
    }
}
AWK
}

ai_probe() {
    ((READONLY)) && { t readonly; MSG=$S; return 126; }
 # type ns pod node ports path identity output-prefix; four workers at most
    local type=$1 ns=$2 pod=$3 node=$4 ports=$5 path=$6 identity=$7 prefix=$8 child="" port rc=1 tries=0 old=""
    local candidates=() seen="," endpoint="" reason="unavailable" stamp
    trap 'for child in $(jobs -pr); do kill "$child" 2>/dev/null; done; wait; exit 143' TERM INT
    # Kubernetes object names and numeric ports cannot escape the Pod proxy path.
    if [[ ! $path =~ ^/[a-zA-Z0-9_./-]+$ || $path == *..* ]]; then
        printf '%s\037%s\037%s\037invalid metrics path\037-\n' "$type" "$ns/$pod" "$node" >"$prefix.status"; return
    fi
    IFS=',' read -ra candidates <<<"$ports"
    for port in "${candidates[@]}"; do
        [[ $port =~ ^[0-9]{1,5}$ ]] && ((10#$port > 0 && 10#$port <= 65535)) || continue
        [[ $seen == *",$port,"* ]] && continue; seen+="$port,"
        ((++tries > 4)) && break
        endpoint="/api/v1/namespaces/$ns/pods/$pod:$port/proxy$path"
        "$KUBECTL" "${KARGS[@]}" --request-timeout=3s get --raw "$endpoint" >"$prefix.body" 2>"$prefix.err" & child=$!
        wait "$child"; rc=$?; child=""
        if ((rc)); then
            reason="unreachable (port/path/network)"
            if grep -Eqi 'forbidden|unauthorized' "$prefix.err"; then reason="access denied (pods/proxy or endpoint auth)"; break; fi
            continue
        fi
        printf -v stamp '%(%s)T' -1
        { printf '# podtree-id %s\n# podtree-time %s\n' "$identity" "$stamp"; cat "$prefix.body"; } >"$prefix.raw"
        if [[ $type == vllm ]]; then
            old="$TMP/ai-cache/$ns/$pod.raw"; [[ -f $old ]] || old=/dev/null
            LC_ALL=C awk -f "$TMP/ai-prom.awk" -f "$TMP/ai-vllm.awk" "$old" "$prefix.raw" >"$prefix.data"; rc=$?
        else
            LC_ALL=C awk -v node="$node" -f "$TMP/ai-prom.awk" -f "$TMP/ai-gpu.awk" "$prefix.raw" >"$prefix.data"
            [[ -s $prefix.data ]]; rc=$?
        fi
        if ((rc==0)); then reason=ok; break; fi
        reason="no supported metrics (check endpoint)"
    done
    printf '%s\037%s\037%s\037%s\037%s\n' "$type" "$ns/$pod" "$node" "$reason" "${endpoint:--}" >"$prefix.status"
}

ai_fetch() {
    ((READONLY)) && { t readonly; MSG=$S; return 126; }

    local dir=$1 type ns pod node ports path identity n=0 worker workers=() dedup=()
    # Query the shell job table: a signal may arrive between launching a child and
    # appending its PID to workers[]. No newly launched scraper may be orphaned.
    trap 'for worker in $(jobs -pr); do kill "$worker" 2>/dev/null; done; wait; exit 143' TERM INT
    awk -v ns="$NS" -f "$TMP/ai-discover.awk" "$dir/pods" >"$dir/candidates"
    # With -n, GPU exporters may live in a different namespace. Failure here does
    # not prevent monitoring vLLM pods that are readable in the selected namespace.
    if [[ -n $NS ]]; then
        "$KUBECTL" "${KARGS[@]}" --request-timeout=5s get pods -A -o go-template="$POD_TPL" >"$dir/global" 2>"$dir/discovery.err" & workers=($!)
        if wait "${workers[0]}"; then awk -v onlydcgm=1 -f "$TMP/ai-discover.awk" "$dir/global" >>"$dir/candidates"; fi
        workers=()
    fi
    LC_ALL=C sort -u "$dir/candidates" >"$dir/list"
    while IFS=$'\037' read -r type ns pod node ports path identity; do
        [[ -n $pod ]] || continue
        ai_probe "$type" "$ns" "$pod" "$node" "$ports" "$path" "$identity" "$dir/$n" & workers+=($!)
        ((n++))
        if ((${#workers[@]}>=4)); then wait "${workers[@]}"; workers=(); fi
    done <"$dir/list"
    ((${#workers[@]})) && wait "${workers[@]}"
    printf '%s\n' "$n" >"$dir/done"
}

ai_stop() {
    if [[ -n $AI_PID ]]; then kill "$AI_PID" 2>/dev/null; wait "$AI_PID" 2>/dev/null; AI_PID=""; fi
}
ai_reset() {
    ai_stop
    AI_LAST=0 AI_STAMP=0 AI_STATUS=starting AI_DATA=() AI_MODELS=() AI_STATE=() AI_TYPE=() AI_SEEN=() AI_ENDPOINT=() AI_GPU=() AI_GPU_SEEN=() AI_NODE_GPU=() AI_GPU_PODS=()
    AI_M=() AI_P=() AI_MP=() AI_H=() AI_PMODEL=() AI_PNODE=() AI_PSTATE_PREV=() AI_STALL=() AI_KVHI=() AI_POD_GPU=() AI_GPU_ROWS=() AI_MLIST=() AI_EV=() AI_NSAMPLE=0
    # Rotate cache rather than comparing samples from two Kubernetes contexts.
    [[ -d $TMP/ai-cache ]] && rm -rf "$TMP/ai-cache"
    mkdir -p "$TMP/ai-cache"
}
ai_start() {
    ((READONLY)) && { t readonly; MSG=$S; return 126; }

    ((AI_ON)) && [[ -z $AI_PID && -z $FETCH_PID && -f $TMP/pods.snapshot ]] || return 0
    [[ -f $TMP/ai-prom.awk ]] || ai_init
    mkdir -p "$TMP/ai-cache"
    AI_DIR=$(mktemp -d "$TMP/ai.XXXXXX") || return
    cp "$TMP/pods.snapshot" "$AI_DIR/pods"
    ai_fetch "$AI_DIR" </dev/null & AI_PID=$!
    now_epoch; AI_LAST=$NOW
}
ai_check() {
    [[ -n $AI_PID ]] || return 1
    if [[ ! -f $AI_DIR/done ]]; then
        kill -0 "$AI_PID" 2>/dev/null && return 1
        ai_reset
        AI_STATUS='collector interrupted; retry pending'; now_epoch; AI_LAST=$NOW
        DIRTY=1
        return 0
    fi
    wait "$AI_PID" 2>/dev/null; AI_PID=""
    local count i type key node state endpoint row kind model rest id gpu gname util used total temp watts maps pk summary good=0 failures=0
    local -A known=() nodeutil=() nodemem=() pu=() pused=() ptot=()
    count=$(<"$AI_DIR/done")
    AI_DATA=() AI_MODELS=() AI_STATE=() AI_TYPE=() AI_SEEN=() AI_ENDPOINT=() AI_GPU=() AI_GPU_SEEN=() AI_NODE_GPU=() AI_GPU_PODS=() AI_POD_GPU=() AI_GPU_ROWS=()
    for ((i=0;i<count;i++)); do
        [[ -s $AI_DIR/$i.status ]] || { ((failures++)); continue; }
        IFS=$'\037' read -r type key node state endpoint <"$AI_DIR/$i.status"
        [[ -n $key ]] || continue
        AI_STATE[$key]=$state; AI_TYPE[$key]=$type; AI_ENDPOINT[$key]=$endpoint; AI_PNODE[$key]=$node
        if [[ $state != ok ]]; then ((failures++)); rm -f "$TMP/ai-cache/$key.raw"; continue; fi
        ((good++))
        AI_SEEN[$key]=$(awk '/^# podtree-time /{print $3;exit}' "$AI_DIR/$i.raw")
        if [[ $type == vllm ]]; then
            mkdir -p "$TMP/ai-cache/${key%/*}"
            cp "$AI_DIR/$i.raw" "$TMP/ai-cache/$key.raw"
            while IFS=$'\037' read -r kind model rest; do
                if [[ $kind == A ]]; then AI_DATA[$key]=$rest
                else AI_MODELS[$key]+="${AI_MODELS[$key]:+$'\n'}$model"$'\037'"$rest"; fi
            done < <(LC_ALL=C sort "$AI_DIR/$i.data")
        else
            while IFS=$'\037' read -r node id gpu gname util used total temp watts maps; do
                pk="$node/$id"
                # Duplicate exporters/label sets must not multiply device utilization.
                [[ -n ${known[$pk]+x} ]] && continue; known[$pk]=1
                local memlabel="$used/$total MiB"
                if [[ $used != N/A && $total != N/A ]]; then
                    memlabel=$(awk -v u="$used" -v t="$total" 'BEGIN{printf "%.1f/%.1f GiB",u/1024,t/1024}')
                fi
                row="$gpu | ${gname:-GPU} | GPU ${util}% | VRAM $memlabel | ${temp} C | ${watts} W"
                row=${row//N\/A%/N\/A}
                AI_GPU[$node]+="${AI_GPU[$node]:+$'\n'}$row"
                AI_GPU_ROWS[$node]+="${AI_GPU_ROWS[$node]:+$'\n'}$gpu"$'\037'"$gname"$'\037'"$util"$'\037'"$used"$'\037'"$total"$'\037'"$temp"$'\037'"$watts"$'\037'"$maps"
                if [[ -z ${AI_GPU_SEEN[$node]} ]] || ((AI_SEEN[$key]<AI_GPU_SEEN[$node])); then AI_GPU_SEEN[$node]=${AI_SEEN[$key]}; fi
                if [[ $util != N/A ]]; then nodeutil[$node]+=" $util"; fi
                if [[ $used != N/A && $total != N/A && $total != 0 ]]; then nodemem[$node]+=" $used/$total"; fi
                local mapped=(); IFS=',' read -ra mapped <<<"$maps"
                for pk in "${mapped[@]}"; do
                    [[ -n $pk ]] || continue
                    AI_GPU_PODS[$pk]+="${AI_GPU_PODS[$pk]:+$'\n'}$row"
                    # per pod for the V table: busiest device, VRAM of all its devices
                    [[ $util =~ ^[0-9]+ ]] && { [[ -z ${pu[$pk]} ]] || ((BASH_REMATCH[0] > ${pu[$pk]})); } && pu[$pk]=${BASH_REMATCH[0]}
                    [[ $used =~ ^[0-9]+ && $total =~ ^[0-9]+$ ]] && { pused[$pk]=$((${pused[$pk]:-0} + ${used%%.*})); ptot[$pk]=$((${ptot[$pk]:-0} + total)); }
                done
            done < <(LC_ALL=C sort "$AI_DIR/$i.data")
        fi
    done
    for node in "${!AI_GPU[@]}"; do
        summary=$(awk -v u="${nodeutil[$node]}" -v m="${nodemem[$node]}" 'BEGIN{a="N/A";b="N/A";n=split(u,v," ");for(i=1;i<=n;i++)if(v[i]!=""&&(a=="N/A"||v[i]+0>a))a=v[i]+0;n=split(m,v," ");for(i=1;i<=n;i++){split(v[i],p,"/");if(p[2]>0&&(b=="N/A"||p[1]/p[2]*100>b))b=p[1]/p[2]*100}printf "GPU max %s  VRAM max %s",a=="N/A"?a:sprintf("%.0f%%",a),b=="N/A"?b:sprintf("%.0f%%",b)}')
        AI_NODE_GPU[$node]=$summary
    done
    for pk in "${!pu[@]}" "${!pused[@]}"; do AI_POD_GPU[$pk]="${pu[$pk]:--} ${pused[$pk]:--} ${ptot[$pk]:--}"; done
    ai_hist
    AI_STATUS="$good ok / $failures unavailable"
    [[ $count == 0 ]] && AI_STATUS="no vLLM / DCGM candidates"
    [[ -s $AI_DIR/discovery.err ]] && AI_STATUS+="; GPU discovery restricted"
    now_epoch; AI_STAMP=$NOW
    rm -rf "$AI_DIR"; AI_DIR=""
    [[ -n $FILTER ]] && build_rows
    DIRTY=1
    return 0
}
ai_tick() {
    ((AI_ON)) || return 0
    ai_check && :
    now_epoch
    local iv=$AI_INTERVAL; ((AI_FAST && iv > 5)) && iv=5   # the V monitor samples faster so changes are visible
    [[ -z $AI_PID ]] && ((AI_LAST==0 || (INTERVAL>0 && NOW-AI_LAST>=iv))) && ai_start
    return 0
}
ai_values() { # convenient named variables for the renderer (unknown is not zero)
    IFS=$'\037' read -r AV_RUN AV_WAIT AV_KV AV_DONE AV_DELTA AV_IN AV_OUT AV_TTFT AV_E2E AV_QUEUE AV_DT <<<"$1"
    local var
    for var in AV_RUN AV_WAIT AV_KV AV_DONE AV_DELTA AV_IN AV_OUT AV_TTFT AV_E2E AV_QUEUE; do
        [[ -n ${!var} ]] || printf -v "$var" '%s' N/A
    done
    AV_RUN=${AV_RUN%.000}; AV_WAIT=${AV_WAIT%.000}; AV_DONE=${AV_DONE%.000}
    AV_KV_UNIT='%'; [[ $AV_KV == N/A ]] && AV_KV_UNIT=''
}

ai_report() { # plain, scrollable report for the current tree selection, or all filtered pods
    local scope=$1 key=$2 i pk node line model rest listed=0 age='N/A' sampled='N/A' selected=0
    local -A shown=()
    now_epoch; ((AI_STAMP)) && age="$((NOW-AI_STAMP))s"
    ((AI_STAMP)) && printf -v sampled '%(%Y-%m-%d %H:%M:%S %z)T' "$AI_STAMP"
    if [[ $UI == ko ]]; then
        printf '수집: %s | 마지막 수집 %s 전 | 주기 %ss\n' "$AI_STATUS" "$age" "$AI_INTERVAL"
        printf '수집 완료 시각: %s\n' "$sampled"
        echo '실행/대기는 추론 요청 수입니다. 사용자·대화 세션 수는 수집하지 않습니다.'
    else
        printf 'Collection: %s | last collection %s ago | interval %ss\n' "$AI_STATUS" "$age" "$AI_INTERVAL"
        printf 'Collection completed at: %s\n' "$sampled"
        echo 'RUN/WAIT = inference requests, not users or conversation sessions.'
    fi
    for ((i=0;i<NPODS;i++)); do
        match "$i" || continue
        pk="${P_NS[i]}/${P_NAME[i]}"; node=${P_NODE[i]}; selected=0
        case $scope in
            all) selected=1 ;;
            pod) [[ $key == "pod:$pk" ]] && selected=1 ;;
            node) [[ $key == "node:$node" ]] && selected=1 ;;
            model) [[ $'\n'${AI_MP[$key]}$'\n' == *$'\n'"$pk"$'\n'* ]] && selected=1 ;;
            *) local G1 G2; group_keys "$i"; [[ $key == "$G1" || $key == "$G2" ]] && selected=1 ;;
        esac
        ((selected)) || continue
        if [[ -z ${shown[$node]+x} ]]; then
            shown[$node]=1
            printf '\n[%s]  CPU %s  MEM %s\n' "$node" "${TOPN_CPU[$node]:-N/A}" "${TOPN_MEM[$node]:-N/A}"
            if [[ -n ${AI_GPU[$node]} ]]; then
                printf '  %s\n' "${AI_NODE_GPU[$node]}"
                if [[ $scope == node ]]; then while IFS= read -r line; do printf '  GPU %s\n' "$line"; done <<<"${AI_GPU[$node]}"; fi
            else echo '  GPU N/A — DCGM Exporter not discovered/readable for this worker'; fi
            [[ -n ${AI_GPU_SEEN[$node]} ]] && printf '  GPU sample age: %ss\n' "$((NOW-AI_GPU_SEEN[$node]))"
        fi
        ((listed++))
        printf '\n  %s  [%s]  CPU %s  MEM %s\n' "$pk" "${P_STATUS[i]}" "${TOP_CPU[$pk]:-N/A}" "${TOP_MEM[$pk]:-N/A}"
        if [[ ${AI_TYPE[$pk]} == dcgm ]]; then printf '    DCGM Exporter: %s\n' "${AI_STATE[$pk]}"; continue; fi
        if [[ -z ${AI_TYPE[$pk]} && $scope != pod ]]; then continue; fi
        if [[ -n ${AI_SEEN[$pk]} ]]; then
            local elapsed=$((NOW-AI_SEEN[$pk])) freshness=''
            ((elapsed>30)) && freshness=' [STALE]'
            printf '    Sample age: %ss%s\n' "$elapsed" "$freshness"
        fi
        if [[ -n ${AI_DATA[$pk]} ]]; then
            while IFS=$'\037' read -r model rest; do
                ai_values "$rest"
                printf '    MODEL %s\n' "$model"
                if [[ $UI == ko ]]; then
                    printf '    실행 %-7s 대기 %-7s KV(최대) %s%s   출력 %s tok/s\n' "$AV_RUN" "$AV_WAIT" "$AV_KV" "$AV_KV_UNIT" "$AV_OUT"
                    printf '    완료 +%s / %s초  누적 %s건   입력 %s tok/s\n' "$AV_DELTA" "$AV_DT" "$AV_DONE" "$AV_IN"
                    printf '    평균 지연(초)  첫 토큰 %s   응답 %s   대기 %s\n' "$AV_TTFT" "$AV_E2E" "$AV_QUEUE"
                else
                    printf '    RUN %-7s WAIT %-7s KV(max) %s%s   OUT %s tok/s\n' "$AV_RUN" "$AV_WAIT" "$AV_KV" "$AV_KV_UNIT" "$AV_OUT"
                    printf '    DONE +%s / %ss  total %s   IN %s tok/s\n' "$AV_DELTA" "$AV_DT" "$AV_DONE" "$AV_IN"
                    printf '    MEAN(s)  first token %s   response %s   queue %s\n' "$AV_TTFT" "$AV_E2E" "$AV_QUEUE"
                fi
            done <<<"${AI_MODELS[$pk]}"
        else
            printf '    vLLM N/A — %s\n' "${AI_STATE[$pk]:-not detected (custom image? use podtree.io/monitor=vllm)}"
        fi
        [[ -n ${AI_ENDPOINT[$pk]} ]] && printf '    GET %s\n' "${AI_ENDPOINT[$pk]}"
        if [[ -n ${AI_GPU_PODS[$pk]} ]]; then
            while IFS= read -r line; do printf '    ASSIGNED DEVICE %s\n' "$line"; done <<<"${AI_GPU_PODS[$pk]}"
        else echo '    ASSIGNED GPU N/A — no namespace/pod mapping from exporter'; fi
    done
    ((listed)) || echo 'No pods in this selection. Press a for all filtered pods.'
    if [[ $UI == ko ]]; then
        echo
        echo '완료=request_success의 종료 사유별 합계. 처리량/평균 지연은 최근 두 수집 사이의 값.'
        echo 'N/A=미수집·조회 불가·첫 수집·리셋. 0=관측한 0. GPU는 공유 여부와 관계없이 장치 전체 값.'
        echo '워커의 모든 GPU/MIG를 펼치려면 트리에서 워커를 선택하고 V를 누르세요.'
        printf '\n조회 불가: pods/proxy 권한·포트·인증을 확인하세요. 미탐색: podtree.io/monitor=vllm|dcgm\n'
        echo '포트/경로 예외: podtree.io/metrics-port, podtree.io/metrics-path (Pod annotation).'
    else
        echo
        echo 'DONE = request_success across finish reasons. Rates/mean latencies use the last sample interval.'
        echo 'N/A = missing/unavailable/first sample/reset; 0 = observed zero. GPU values cover the whole device.'
        echo 'Select a worker in the tree and press V to list all its GPUs/MIG instances.'
        printf '\nUnavailable: check pods/proxy RBAC, port and auth. Discovery override: podtree.io/monitor=vllm|dcgm\n'
        echo 'Endpoint overrides: podtree.io/metrics-port, podtree.io/metrics-path (Pod annotations).'
    fi
}
# ---------------------------------------------------------------- vLLM monitor (V): model > pod table, changes, trends, resources
# After every collection ai_hist turns the samples into integer fields ("-" = unknown, never 0):
#   AI_M[model] / AI_P[ns/pod|model] = 0 ok-pods 1 pods 2 run 3 wait 4 kv% 5 done(last interval) 6 interval s
#   7 out tok/s 8 in tok/s 9 ttft ms 10 e2e ms 11 queue ms 12 done total 13 gpu% 14 vram MiB 15 vram total MiB
#   16 cpu m 17 mem MiB 18 done/min        AI_M[@all] = every model together
# AI_H["M|model|run"], ["P|ns/pod|model|wait"], ... keep the last AI_HN values for trends and up/down arrows.
ai_int() {   # ai_int VAR DECIMAL SCALE(1|10|1000) -> integer DECIMAL*SCALE, "-" when unknown
    local f
    [[ $2 =~ ^([0-9]+)(\.([0-9]*))?$ ]] || { printf -v "$1" '%s' -; return; }
    f=${BASH_REMATCH[3]}000; f=${f:0:${#3}-1}
    printf -v "$1" '%d' $((10#${BASH_REMATCH[1]} * $3 + 10#${f:-0}))
}
ai_plain() {   # ai_plain VAR TEXT : TEXT without SGR color sequences
    local s=$2 pre
    while [[ $s == *$'\e['* ]]; do pre=${s%%$'\e['*}; s=${s#*$'\e['}; s=$pre${s#*m}; done
    printf -v "$1" '%s' "$s"
}
ai_cpu() {   # kubectl top cpu (250m / 2) -> millicores
    if [[ $2 =~ ^([0-9]+)m$ ]]; then printf -v "$1" '%d' $((10#${BASH_REMATCH[1]}))
    elif [[ $2 =~ ^[0-9]+$ ]]; then printf -v "$1" '%d' $((10#$2 * 1000))
    else printf -v "$1" '%s' -; fi
}
ai_mem() {   # kubectl top memory (512Mi / 14Gi / 900Ki) -> MiB
    [[ $2 =~ ^([0-9]+)(Ki|Mi|Gi|Ti)?$ ]] || { printf -v "$1" '%s' -; return; }
    local v=$((10#${BASH_REMATCH[1]}))
    case ${BASH_REMATCH[2]} in Ki) v=$((v / 1024)) ;; Gi) v=$((v * 1024)) ;; Ti) v=$((v * 1048576)) ;; '') v=$((v / 1048576)) ;; esac
    printf -v "$1" '%d' "$v"
}
ai_push() {   # ai_push KEY VALUE : append to the caller's newh[KEY] (series of the previous collection + VALUE)
    local a=(${AI_H[$1]} "$2")
    ((${#a[@]} > AI_HN)) && a=("${a[@]: -AI_HN}")
    newh[$1]="${a[*]}"
}
ai_ev() {   # ai_ev bad|warn|ok|info EN KO : vLLM change log (V); all but info also go to the change history (H)
    local ts m=$2; [[ $UI == ko ]] && m=$3
    printf -v ts '%(%H:%M:%S)T' -1
    AI_EV+=("$1"$'\037'"$ts"$'\037'"$m")
    ((${#AI_EV[@]} > 400)) && AI_EV=("${AI_EV[@]:200}")
    [[ $1 == info ]] || hist_add "$1" "vLLM $m"   # busy / idle flips would flood H
}
ai_hist() {   # after each collection: fields per model / pod, trend series, change log
    local pk m k i v cur run wait kv done delta in out ttft e2e queue dt dpm gu vu vt cpu mem first okp=0 allp=0 name
    local -A acc=() cnt=() newh=() prevm=() prevp=() mp=() wlm=() pwl=()
    local F=() O=() N=()
    for k in "${!AI_M[@]}"; do prevm[$k]=${AI_M[$k]}; done
    for k in "${!AI_P[@]}"; do prevp[$k]=${AI_P[$k]}; done
    # replicas of one workload serve one model: a pod that never answered goes under its siblings' model
    for ((i = 0; i < NPODS; i++)); do
        pk=${P_NS[i]}/${P_NAME[i]}; [[ -n ${AI_TYPE[$pk]} && -n ${P_WL[i]} && ${P_WL[i]} != Pod/* ]] || continue
        pwl[$pk]=${P_NS[i]}/${P_WL[i]}
        [[ ${AI_STATE[$pk]} == ok && -n ${AI_MODELS[$pk]} ]] && wlm[${pwl[$pk]}]=${AI_MODELS[$pk]%%$'\037'*}
    done
    AI_M=() AI_P=() AI_MP=() AI_MLIST=()
    for pk in "${!AI_TYPE[@]}"; do
        [[ ${AI_TYPE[$pk]} == vllm ]] || continue
        ((allp++))
        if [[ ${AI_STATE[$pk]} != ok || -z ${AI_MODELS[$pk]} ]]; then
            m=${AI_PMODEL[$pk]}               # a failing replica stays under the model it served last
            [[ -z $m && -n ${pwl[$pk]} ]] && m=${wlm[${pwl[$pk]}]}
            [[ -z $m ]] && m=$AI_NA
            mp[$m]+="$pk"$'\n'; acc[$m|1]=$((${acc[$m|1]:-0} + 1))
            for k in run wait dpm kv; do ai_push "P|$pk|$m|$k" -; done
            continue
        fi
        ((okp++)); first=1
        while IFS=$'\037' read -r m run wait kv done delta in out ttft e2e queue dt; do
            [[ -n $m ]] || continue
            ((first)) && { AI_PMODEL[$pk]=$m; first=0; }
            ai_int run "$run" 1; ai_int wait "$wait" 1; ai_int kv "$kv" 1; ai_int done "$done" 1; ai_int delta "$delta" 1
            ai_int dt "$dt" 1; ai_int out "$out" 1; ai_int in "$in" 1
            ai_int ttft "$ttft" 1000; ai_int e2e "$e2e" 1000; ai_int queue "$queue" 1000
            dpm=-; [[ $delta != - && $dt != - ]] && ((dt > 0)) && dpm=$((delta * 60 / dt))
            read -r gu vu vt <<<"${AI_POD_GPU[$pk]:-- - -}"
            ai_int gu "$gu" 1; ai_int vu "$vu" 1; ai_int vt "$vt" 1
            ai_cpu cpu "${TOP_CPU[$pk]}"; ai_mem mem "${TOP_MEM[$pk]}"
            F=(1 1 "$run" "$wait" "$kv" "$delta" "$dt" "$out" "$in" "$ttft" "$e2e" "$queue" "$done" "$gu" "$vu" "$vt" "$cpu" "$mem" "$dpm")
            AI_P[$pk|$m]="${F[*]}"
            mp[$m]+="$pk"$'\n'
            for k in "$m" @all; do
                for ((i = 0; i < 19; i++)); do
                    v=${F[i]}; [[ $v == - ]] && continue
                    [[ $k == @all ]] && ((i < 2)) && continue
                    cur=${acc[$k|$i]}
                    case $i in
                        4|6|13) [[ -z $cur ]] || ((v > cur)) && acc[$k|$i]=$v ;;     # maximum
                        *) acc[$k|$i]=$((${cur:-0} + v)) ;;                          # sum (9-11: mean below)
                    esac
                    cnt[$k|$i]=$((${cnt[$k|$i]:-0} + 1))
                done
            done
            ai_push "P|$pk|$m|run" "$run"; ai_push "P|$pk|$m|wait" "$wait"; ai_push "P|$pk|$m|dpm" "$dpm"; ai_push "P|$pk|$m|kv" "$kv"
        done <<<"${AI_MODELS[$pk]}"
    done
    ((allp)) && { acc[@all|0]=$okp; acc[@all|1]=$allp; mp[@all]=x; }
    for m in "${!mp[@]}"; do
        F=()
        for ((i = 0; i < 19; i++)); do
            v=${acc[$m|$i]}
            if [[ -z $v ]]; then if ((i < 2)); then v=0; else v=-; fi
            elif ((i >= 9 && i <= 11)); then v=$((v / ${cnt[$m|$i]})); fi
            F+=("$v")
        done
        AI_M[$m]="${F[*]}"
        ai_push "M|$m|run" "${F[2]}"; ai_push "M|$m|wait" "${F[3]}"; ai_push "M|$m|dpm" "${F[18]}"; ai_push "M|$m|kv" "${F[4]}"
        [[ $m == @all ]] && continue
        AI_MP[$m]=$(LC_ALL=C sort <<<"${mp[$m]%$'\n'}")
        [[ $m == "$AI_NA" ]] || AI_MLIST+=("$m")
    done
    ((${#AI_MLIST[@]})) && mapfile -t AI_MLIST < <(printf '%s\n' "${AI_MLIST[@]}" | LC_ALL=C sort)
    [[ -n ${mp[$AI_NA]} ]] && AI_MLIST+=("$AI_NA")
    AI_H=(); for k in "${!newh[@]}"; do AI_H[$k]=${newh[$k]}; done

    # change log: compare with the previous collection (the first one is the baseline)
    if ((AI_NSAMPLE)); then
        for m in "${AI_MLIST[@]}"; do
            [[ $m == "$AI_NA" ]] && continue
            N=(${AI_M[$m]})
            if [[ -z ${prevm[$m]} ]]; then ai_ev info "$m: new model (${N[1]} pods)" "$m: 새 모델 감지 (파드 ${N[1]})"; continue; fi
            O=(${prevm[$m]})
            ((N[0] < O[0])) && ai_ev bad "$m: answering pods ${O[0]} -> ${N[0]} (of ${N[1]})" "$m: 응답 파드 ${O[0]} → ${N[0]} (전체 ${N[1]})"
            ((N[0] > O[0])) && ai_ev ok "$m: answering pods ${O[0]} -> ${N[0]}" "$m: 응답 파드 ${O[0]} → ${N[0]}"
            if [[ ${N[3]} != - && ${O[3]} != - ]]; then
                if ((O[3] == 0 && N[3] > 0)); then ai_ev warn "$m: requests waiting 0 -> ${N[3]} (running ${N[2]})" "$m: 대기 발생 0 → ${N[3]} (실행 ${N[2]})"
                elif ((O[3] > 0 && N[3] == 0)); then ai_ev ok "$m: queue cleared (${O[3]} -> 0)" "$m: 대기 해소 (${O[3]} → 0)"
                elif ((N[3] >= O[3] + 5 && N[3] >= 2 * O[3])); then ai_ev warn "$m: waiting surged ${O[3]} -> ${N[3]}" "$m: 대기 급증 ${O[3]} → ${N[3]}"; fi
            fi
            if [[ ${N[2]} != - && ${O[2]} != - ]]; then
                if ((O[2] == 0 && N[2] > 0)); then ai_ev info "$m: busy (running ${N[2]})" "$m: 처리 시작 (실행 ${N[2]})"
                elif ((O[2] > 0 && N[2] == 0)) && [[ ${N[3]} == 0 ]]; then ai_ev info "$m: idle (completed +${N[5]})" "$m: 유휴 (완료 +${N[5]})"; fi
            fi
            if [[ ${N[4]} != - ]]; then
                if ((N[4] >= 90)) && [[ -z ${AI_KVHI[$m]} ]]; then AI_KVHI[$m]=1; ai_ev warn "$m: KV cache ${N[4]}%" "$m: KV 캐시 ${N[4]}%"
                elif ((N[4] < 80)) && [[ -n ${AI_KVHI[$m]} ]]; then unset "AI_KVHI[$m]"; ai_ev ok "$m: KV cache back to ${N[4]}%" "$m: KV 캐시 ${N[4]}%로 회복"; fi
            fi
        done
        # per replica: requests running but no generated token in two collections in a row = stuck engine / hung GPU
        for k in "${!AI_P[@]}"; do
            [[ -n ${prevp[$k]} ]] || continue
            N=(${AI_P[$k]}); O=(${prevp[$k]}); pk=${k%%|*}
            if [[ ${N[2]} != - && ${O[2]} != - && ${N[7]} == 0 && ${O[7]} == 0 ]] && ((N[2] > 0 && O[2] > 0)); then
                [[ -z ${AI_STALL[$k]} ]] && { AI_STALL[$k]=1; ai_ev bad "$pk: ${N[2]} running but 0 tokens/s for ~$((N[6] * 2))s - stalled?" "$pk: 실행 ${N[2]}건인데 약 $((N[6] * 2))초 동안 출력 0 tok/s - 처리 정지 의심"; }
            elif [[ -n ${AI_STALL[$k]} ]] && [[ ${N[7]} != 0 && ${N[7]} != - ]]; then
                unset "AI_STALL[$k]"; ai_ev ok "$pk: generating again (${N[7]} tok/s)" "$pk: 출력 재개 (${N[7]} tok/s)"
            fi
        done
        for m in "${!prevm[@]}"; do
            [[ $m == @all || $m == "$AI_NA" || -n ${AI_M[$m]} ]] && continue
            ai_ev warn "$m: model gone (no pod reports it)" "$m: 모델 사라짐 (보고하는 파드 없음)"
        done
        for pk in "${!AI_TYPE[@]}"; do
            [[ ${AI_TYPE[$pk]} == vllm ]] || continue
            v=${AI_STATE[$pk]}; cur=${AI_PSTATE_PREV[$pk]}
            if [[ $v == ok && -z $cur ]]; then ai_ev info "$pk: new pod (${AI_PMODEL[$pk]})" "$pk: 새 파드 (${AI_PMODEL[$pk]})"
            elif [[ $v == ok && $cur != ok ]]; then ai_ev ok "$pk: metrics readable again" "$pk: 수집 복구"
            elif [[ $v != ok && $cur != "$v" ]]; then ai_ev bad "$pk: metrics unavailable - $v" "$pk: 수집 불가 - $v"; fi
        done
        for pk in "${!AI_PSTATE_PREV[@]}"; do
            [[ -n ${AI_TYPE[$pk]} ]] || ai_ev warn "$pk: pod gone or not Running" "$pk: 파드 사라짐 또는 Running 아님"
        done
    fi
    if ((!AI_NSAMPLE)) && ((allp)); then
        ai_ev info "collection started: ${#AI_MLIST[@]} models, $okp/$allp pods answering" "수집 시작: 모델 ${#AI_MLIST[@]}개, 파드 $okp/$allp 응답"
    fi
    AI_PSTATE_PREV=()
    for pk in "${!AI_TYPE[@]}"; do [[ ${AI_TYPE[$pk]} == vllm ]] && AI_PSTATE_PREV[$pk]=${AI_STATE[$pk]}; done
    ((AI_NSAMPLE++))
}

ai_num() {   # ai_num VAR INT -> 1234 / 12.3k / 4.5M
    local v=$2
    if [[ $v == - ]]; then printf -v "$1" '%s' -
    elif ((v >= 1000000)); then printf -v "$1" '%d.%dM' $((v / 1000000)) $((v % 1000000 / 100000))
    elif ((v >= 10000)); then printf -v "$1" '%d.%dk' $((v / 1000)) $((v % 1000 / 100))
    else printf -v "$1" '%d' "$v"; fi
}
ai_sec() {   # ai_sec VAR MS -> 0.81s / 12.3s / 123s
    local v=$2
    if [[ $v == - ]]; then printf -v "$1" '%s' -
    elif ((v < 10000)); then printf -v "$1" '%d.%02ds' $((v / 1000)) $((v % 1000 / 10))
    elif ((v < 100000)); then printf -v "$1" '%d.%ds' $((v / 1000)) $((v % 1000 / 100))
    else printf -v "$1" '%ds' $((v / 1000)); fi
}
ai_gib() {   # ai_gib VAR MiB -> 143G / 1.2T
    local v=$2
    if [[ $v == - ]]; then printf -v "$1" '%s' -
    elif ((v >= 1024 * 1000)); then printf -v "$1" '%d.%dT' $((v / 1048576)) $((v % 1048576 * 10 / 1048576))
    else printf -v "$1" '%dG' $(((v + 512) / 1024)); fi
}
ai_cpus() {  # ai_cpus VAR MILLICORES -> 850m / 12.4
    if [[ $2 == - ]]; then printf -v "$1" '%s' -
    elif (($2 < 1000)); then printf -v "$1" '%dm' "$2"
    else printf -v "$1" '%d.%d' $(($2 / 1000)) $(($2 % 1000 / 100)); fi
}
ai_mib() {   # ai_mib VAR MiB -> 512Mi / 14.0Gi
    if [[ $2 == - ]]; then printf -v "$1" '%s' -
    elif (($2 < 1024)); then printf -v "$1" '%dMi' "$2"
    else printf -v "$1" '%d.%dGi' $(($2 / 1024)) $(($2 % 1024 * 10 / 1024)); fi
}
ai_series() {   # ai_series KEY N -> SER = last N values, "" padded in front
    local a=(${AI_H[$1]}) k=$2
    if ((${#a[@]} >= k)); then SER=("${a[@]: -k}"); return; fi
    SER=(); for ((k -= ${#a[@]}; k > 0; k--)); do SER+=(""); done
    SER+=("${a[@]}")
}
ai_prev() {   # ai_prev KEY -> PREV = value of the collection before the latest ("-" when none)
    local a=(${AI_H[$1]}) n
    n=${#a[@]}; PREV=-; ((n >= 2)) && PREV=${a[n - 2]}
}
ai_spark() {   # ai_spark VAR WIDTH KEY [KEY2] [COLOR] : sparkline; with KEY2 bars are KEY+KEY2 (yellow when KEY2 > 0, red when KEY2 > KEY)
    local w=$2 a=() b=() i v x max=0 idx out="" c pc="" glyph
    ai_series "$3" "$w"; a=("${SER[@]}")
    if [[ -n $4 ]]; then ai_series "$4" "$w"; b=("${SER[@]}"); fi
    for ((i = 0; i < w; i++)); do
        v=${a[i]}; [[ $v == [0-9]* ]] || continue
        x=${b[i]}; [[ $x == [0-9]* ]] && ((v += x))
        ((v > max)) && max=$v
    done
    for ((i = 0; i < w; i++)); do
        v=${a[i]}; x=${b[i]}
        if [[ $v != [0-9]* ]]; then c=""; glyph=" "
        else
            [[ $x == [0-9]* ]] || x=0
            if ((v + x == 0)); then c=$C_DIM; glyph=${G_SPK[0]}
            else
                idx=$((((v + x) * 7 + max - 1) / max)); ((idx < 1)) && idx=1; ((idx > 7)) && idx=7
                glyph=${G_SPK[idx]}; c=${5:-$C_OK}
                ((x > 0)) && c=$C_WARN; ((x > v)) && c=$C_BAD
            fi
        fi
        [[ $c != "$pc" ]] && { out+="$C_END$c"; pc=$c; }
        out+=$glyph
    done
    printf -v "$1" '%s' "$out$C_END"
}
ai_bar() {   # ai_bar VAR PERCENT CELLS : colored bar + " 78%"  (CELLS + 5 columns)
    local p=$2 n=$3 f s="" e="" c i
    if [[ $p == - ]]; then printf -v s '%*s' $((n + 5)) '-'; printf -v "$1" '%s' "$C_DIM$s$C_END"; return; fi
    ((p > 100)) && p=100
    f=$(((p * n + 50) / 100)); ((p > 0 && f == 0)) && f=1
    for ((i = 0; i < n; i++)); do if ((i < f)); then s+=$G_FULL; else e+=$G_EMPTY; fi; done
    pct_color c "$p"; [[ -z $c ]] && c=$C_OK
    printf -v "$1" '%s%s%s%s%s %3d%%%s' "$c" "$s" "$C_DIM" "$e" "$C_END$c" "$p" "$C_END"
}
ai_dcell() {   # ai_dcell VALUE PREV WIDTH UP-COLOR DOWN-COLOR VALUE-COLOR -> CELL : "  12▲3  " value right, change after it
    local v=$1 p=$2 w=$3 d a="" num vw=$(($3 - 4))
    ((w == 0)) && vw=0
    if [[ $v == - ]]; then printf -v CELL '%*s' "$w" '-'; CELL="$C_DIM$CELL$C_END"; return; fi
    printf -v num '%*s' "$vw" "$v"
    if [[ $p == [0-9]* ]] && ((v != p)); then
        d=$((v - p))
        if ((d > 0)); then ((d > 999)) && d=999; a="$4$G_UP$d$C_END"
        else d=$((-d)); ((d > 999)) && d=999; a="$5$G_DN$d$C_END"; fi
        ((w)) && printf -v num '%s%s%*s' "$6$num$C_END" "$a" $((3 - ${#d})) ''
        ((w)) || num="$6$num$C_END$a"
    else
        ((w)) && num="$6$num$C_END    "
        ((w)) || num="$6$num$C_END"
    fi
    CELL=$num
}
ai_cell() {   # ai_cell ID : one column of the row in F[] / series prefix sk  -> CELL (exactly AI_CW[ID] columns)
    local id=$1 w=${AI_CW[$1]} v c s
    case $id in
        pods)
            if [[ $kind == pod ]]; then printf -v CELL '%*s' "$w" "$G_OK"; CELL="$C_OK$CELL$C_END"; return; fi
            local tot=$((F[1] + ${AI_XP[$m]:-0}))
            printf -v s '%*s' "$w" "${F[0]}/$tot"; c=""; ((F[0] < tot)) && c=$C_BAD
            CELL="$c$s$C_END" ;;
        run)  ai_prev "$sk|run"; ai_dcell "${F[2]}" "$PREV" "$w" "$C_NS" "$C_DIM" "$C_BOLD" ;;
        wait) c=$C_DIM; [[ ${F[3]} != - ]] && ((F[3] > 0)) && { c=$C_WARN; [[ ${F[2]} != - ]] && ((F[3] > F[2])) && c=$C_BAD; }
              ai_prev "$sk|wait"; ai_dcell "${F[3]}" "$PREV" "$w" "$C_BAD" "$C_OK" "$c" ;;
        load) ai_spark CELL "$w" "$sk|run" "$sk|wait" ;;
        dtrend) ai_spark CELL "$w" "$sk|dpm" "" "$C_NS" ;;
        done) v=${F[5]}; c=$C_DIM; s=-
              [[ $v != - ]] && { s="+$v"; ((v > 0)) && c="$C_OK$C_BOLD"; }
              printf -v s '%*s' "$w" "$s"; CELL="$c$s$C_END" ;;
        dpm)  ai_num s "${F[18]}"; printf -v CELL '%*s' "$w" "$s" ;;
        kv)   ai_bar CELL "${F[4]}" $((w - 5)) ;;
        out)  ai_num s "${F[7]}"; printf -v CELL '%*s' "$w" "$s"; [[ ${F[7]} == 0 ]] && [[ ${F[2]} != - ]] && ((F[2] > 0)) && CELL="$C_WARN$CELL$C_END" ;;
        in)   ai_num s "${F[8]}"; printf -v CELL '%*s' "$w" "$s" ;;
        ttft) ai_sec s "${F[9]}"; printf -v CELL '%*s' "$w" "$s"; [[ ${F[9]} != - ]] && ((F[9] >= 2000)) && CELL="$C_WARN$CELL$C_END" ;;
        e2e)  ai_sec s "${F[10]}"; printf -v CELL '%*s' "$w" "$s" ;;
        queue) ai_sec s "${F[11]}"; printf -v CELL '%*s' "$w" "$s"; [[ ${F[11]} != - ]] && ((F[11] >= 1000)) && CELL="$C_WARN$CELL$C_END" ;;
        gpu)  s=-; [[ ${F[13]} != - ]] && s="${F[13]}%"; pct_color c "${F[13]}"; printf -v s '%*s' "$w" "$s"; CELL="$c$s$C_END" ;;
        vram) s=-; c=""
              if [[ ${F[14]} != - && ${F[15]} != - ]] && ((F[15] > 0)); then
                  local u t; ai_gib u "${F[14]}"; ai_gib t "${F[15]}"; s="$u/$t"; pct_color c $((F[14] * 100 / F[15]))
              fi
              printf -v s '%*s' "$w" "$s"; CELL="$c$s$C_END" ;;
        cpu)  ai_cpus s "${F[16]}"; printf -v CELL '%*s' "$w" "$s" ;;
        mem)  ai_mib s "${F[17]}"; printf -v CELL '%*s' "$w" "$s" ;;
        total) ai_num s "${F[12]}"; printf -v CELL '%*s' "$w" "$s" ;;
    esac
}
ai_vcols() {   # which columns fit: VC (left to right), VNAME_W
    local prio=(run wait done kv load pods out dpm gpu vram ttft e2e cpu mem dtrend queue in total)
    local order=(pods run wait load done dpm dtrend kv out in ttft e2e queue gpu vram cpu mem total)
    local -A on=()
    local used=0 id w min=24 x
    AI_CW[load]=12; AI_CW[dtrend]=10
    for id in "${prio[@]}"; do
        w=${AI_CW[$id]}
        ((min + used + w + 1 <= COLUMNS - 1)) || continue
        on[$id]=1; ((used += w + 1))
    done
    VC=(); for id in "${order[@]}"; do [[ -n ${on[$id]} ]] && VC+=("$id"); done
    x=$((COLUMNS - 1 - used - 46))   # wide terminal: longer trends rather than empty space
    if ((x > 0)) && [[ -n ${on[load]} ]]; then w=$((x > 18 ? 18 : x)); ((AI_CW[load] += w, used += w, x -= w)); fi
    if ((x > 0)) && [[ -n ${on[dtrend]} ]]; then w=$((x > 10 ? 10 : x)); ((AI_CW[dtrend] += w, used += w)); fi
    VNAME_W=$((COLUMNS - 1 - used)); ((VNAME_W > 46)) && VNAME_W=46; ((VNAME_W < 8)) && VNAME_W=8
}
ai_open() { [[ ${AI_FOLD[$1]:-$AI_FOLDDEF} == 0 ]]; }
ai_vrows() {   # VR_KIND / VR_KEY: model > pods (+ replicas that are not Running), then worker > GPU devices
    local m pk i v node line list=() xp=()
    local -A xmap=() wls=()
    VR_KIND=() VR_KEY=() AI_XP=() AI_PIDX=()
    for ((i = 0; i < NPODS; i++)); do
        pk=${P_NS[i]}/${P_NAME[i]}; AI_PIDX[$pk]=$i
        [[ -z ${AI_TYPE[$pk]} && -n ${P_WL[i]} && ${P_WL[i]} != Pod/* ]] && xmap[${P_NS[i]}/${P_WL[i]}]+="$pk"$'\n'
    done
    if [[ $AI_SORT == name ]]; then list=("${AI_MLIST[@]}")
    else
        mapfile -t list < <(for m in "${AI_MLIST[@]}"; do
            local F=(${AI_M[$m]}) a b
            a=${F[2]}; b=${F[3]}; [[ $a == - ]] && a=0; [[ $b == - ]] && b=0
            if [[ $AI_SORT == wait ]]; then v=$b; else v=$((a + b)); fi
            printf '%d\t%s\n' "$v" "$m"
        done | LC_ALL=C sort -t $'\t' -k1,1nr -k2,2 | cut -f2-)
    fi
    for m in "${list[@]}"; do
        VR_KIND+=(model); VR_KEY+=("$m")
        wls=(); xp=()
        while IFS= read -r pk; do
            i=${AI_PIDX[$pk]}; [[ -n $pk && -n $i && -n ${P_WL[i]} ]] && wls[${P_NS[i]}/${P_WL[i]}]=1
        done <<<"${AI_MP[$m]}"
        [[ $m == "$AI_NA" ]] && wls=()
        for v in "${!wls[@]}"; do [[ -n ${xmap[$v]} ]] && mapfile -t -O "${#xp[@]}" xp <<<"${xmap[$v]%$'\n'}"; done
        AI_XP[$m]=${#xp[@]}
        ai_open "$m" || continue
        while IFS= read -r pk; do
            [[ -n $pk ]] || continue
            VR_KEY+=("$pk|$m"); if [[ -n ${AI_P[$pk|$m]} ]]; then VR_KIND+=(pod); else VR_KIND+=(podna); fi
        done <<<"${AI_MP[$m]}"
        for pk in "${xp[@]}"; do VR_KIND+=(xpod); VR_KEY+=("$pk|$m"); done
    done
    if ((${#AI_GPU_ROWS[@]})); then
        VR_KIND+=(sec); VR_KEY+=(gpu)
        while IFS= read -r node; do
            VR_KIND+=(gnode); VR_KEY+=("$node")
            ai_open "g:$node" || continue
            while IFS= read -r line; do VR_KIND+=(gpu); VR_KEY+=("$node"$'\037'"$line"); done <<<"${AI_GPU_ROWS[$node]}"
        done < <(printf '%s\n' "${!AI_GPU_ROWS[@]}" | LC_ALL=C sort)
    fi
}
ai_vid() {   # ai_vid ROW -> VID : stable id of a row (GPU rows: node + device, not the changing values)
    local k=${VR_KEY[$1]} a b
    [[ ${VR_KIND[$1]} == gpu ]] && { IFS=$'\037' read -r a b _ <<<"$k"; k="$a|$b"; }
    VID="${VR_KIND[$1]}:$k"
}
ai_vline() {   # ai_vline ROW SELECTED -> LINE, exactly COLUMNS-1 wide
    local r=$1 kind=${VR_KIND[$1]} key=${VR_KEY[$1]} w=$((COLUMNS - 1)) text="" name rest nc id m pk mk i used
    local F=() sk
    case $kind in
        model|pod)
            if [[ $kind == model ]]; then
                m=$key; F=(${AI_M[$m]}); sk="M|$m"
                if ai_open "$m"; then mk=$G_OPEN; else mk=$G_CLOSED; fi
                if [[ $m == "$AI_NA" ]]; then t ai_na; name=" $mk $S"; nc=$C_BAD; else name=" $mk $m"; nc="$C_NS$C_BOLD"; fi
                padw name "$name" "$VNAME_W"
            else
                pk=${key%%|*}; m=${key#*|}; F=(${AI_P[$key]}); sk="P|$key"; nc=""
                name="     ${pk#*/}"; rest="  ${AI_PNODE[$pk]}"; local rc=$C_DIM nw rw
                [[ -n ${AI_SEEN[$pk]} ]] && ((NOW - AI_SEEN[$pk] > 30)) && { rest="  STALE $((NOW - AI_SEEN[$pk]))s"; rc=$C_WARN; }
                dw nw "$name"; dw rw "$rest"
                if ((nw + rw <= VNAME_W)); then printf -v name '%s%s%s%s%*s' "$name" "$rc" "$rest" "$C_END" $((VNAME_W - nw - rw)) ''
                else padw name "$name" "$VNAME_W"; fi
            fi
            text="$nc$name$C_END"; used=$VNAME_W
            for id in "${VC[@]}"; do ai_cell "$id"; text+=" $CELL"; ((used += AI_CW[$id] + 1)); done
            ((used < w)) && printf -v rest '%*s' $((w - used)) '' && text+=$rest ;;
        podna|xpod)
            pk=${key%%|*}
            padw name "     ${pk#*/}" "$VNAME_W"
            if [[ $kind == podna ]]; then
                rest="$G_NG N/A - ${AI_STATE[$pk]:-not collected yet}"; [[ $UI == ko ]] && rest="$G_NG 수집 불가 - ${AI_STATE[$pk]:-아직 수집 전}"
                padw rest "$rest" $((w - VNAME_W - 1)); text="$name $C_BAD$rest$C_END"
            else
                i=${AI_PIDX[$pk]}; status_color nc "${P_STATUS[i]}" "${P_READY[i]}"
                rest="$G_NG ${P_STATUS[i]} ${P_READY[i]}  (not Running: no metrics)"; [[ $UI == ko ]] && rest="$G_NG ${P_STATUS[i]} ${P_READY[i]}  (Running 아님: 수집 안 함)"
                padw rest "$rest" $((w - VNAME_W - 1)); text="$name $nc$rest$C_END"
            fi ;;
        sec)
            t ai_gpusec; padw rest " $S" "$w"; text="$C_BOLD$rest$C_END" ;;
        gnode)
            local node=$key n=0 su=0 mu=0 uu=0 tt=0 mt=0 pw=0 g gn u us to te wa mp
            while IFS=$'\037' read -r g gn u us to te wa mp; do
                ((n++))
                [[ $u =~ ^[0-9]+ ]] && { ((su += BASH_REMATCH[0])); ((BASH_REMATCH[0] > mu)) && mu=${BASH_REMATCH[0]}; }
                [[ $us =~ ^[0-9]+ && $to =~ ^[0-9]+$ ]] && { ((uu += ${us%%.*})); ((tt += to)); }
                [[ $te =~ ^[0-9]+ ]] && ((BASH_REMATCH[0] > mt)) && mt=${BASH_REMATCH[0]}
                [[ $wa =~ ^[0-9]+ ]] && ((pw += BASH_REMATCH[0]))
            done <<<"${AI_GPU_ROWS[$node]}"
            if ai_open "g:$node"; then mk=$G_OPEN; else mk=$G_CLOSED; fi
            padw name " $mk $node" "$VNAME_W"
            local ut vt
            ai_bar ut $((su / (n ? n : 1))) 5; ((tt)) && ai_bar vt $((uu * 100 / tt)) 5 || ai_bar vt - 5
            local a b; ai_gib a "$uu"; ai_gib b "$tt"
            if [[ $UI == ko ]]; then rest="GPU ${n}개  사용률 평균 $ut 최대 ${mu}%  VRAM $vt $a/$b  최고 ${mt}°C  ${pw}W"
            else rest="${n} GPUs  util avg $ut max ${mu}%  VRAM $vt $a/$b  max ${mt}C  ${pw}W"; fi
            text="$C_BOLD$name$C_END $rest"
            if [[ $UI == ko ]]; then rest="GPU ${n}개  사용률 평균 0123456789 최대 ${mu}%  VRAM 0123456789 $a/$b  최고 ${mt}°C  ${pw}W"
            else rest="${n} GPUs  util avg 0123456789 max ${mu}%  VRAM 0123456789 $a/$b  max ${mt}C  ${pw}W"; fi
            dw used "$name $rest"   # same text with the two bars as 10 plain columns
            ((used < w)) && printf -v rest '%*s' $((w - used)) '' && text+=$rest ;;
        gpu)
            local node g gn u us to te wa mp ub vb a b
            IFS=$'\037' read -r node g gn u us to te wa mp <<<"$key"
            padw name "     #$g ${gn:-GPU}" "$VNAME_W"
            [[ $u =~ ^[0-9]+ ]] && u=${BASH_REMATCH[0]} || u=-
            ai_bar ub "$u" 5
            if [[ $us =~ ^[0-9]+ && $to =~ ^[0-9]+$ ]] && ((to > 0)); then ai_bar vb $((${us%%.*} * 100 / to)) 5; ai_gib a "${us%%.*}"; ai_gib b "$to"
            else ai_bar vb - 5; a=-; b=-; fi
            [[ $te =~ ^[0-9]+ ]] && te="${BASH_REMATCH[0]}C" || te=-
            [[ $wa =~ ^[0-9]+ ]] && wa="${BASH_REMATCH[0]}W" || wa=-
            printf -v rest ' %s  VRAM %s %9s %5s %6s  ' "$ub" "$vb" "$a/$b" "$te" "$wa"
            used=$((VNAME_W + 1 + 10 + 7 + 10 + 10 + 6 + 7 + 2))
            mp=${mp//,/ }; [[ -z $mp ]] && mp=-
            padw a "$mp" $((w - used)); text="$name$rest$C_DIM$a$C_END" ;;
    esac
    if (($2)); then LINE="$C_REV$text$C_RST"; else LINE="$text$C_RST"; fi
}
ai_vhead() {   # column header line -> LINE
    local id hc
    t ai_h_name; padw LINE "   $S" "$VNAME_W"
    LINE="$C_UL$LINE$C_RST"
    for id in "${VC[@]}"; do
        t "ai_h_$id"; local d; dw d "$S"
        if ((d >= AI_CW[$id])); then padw hc "$S" "${AI_CW[$id]}"
        elif [[ $id == load || $id == dtrend || $id == kv ]]; then padw hc "$S" "${AI_CW[$id]}"
        else printf -v hc '%*s%s' $((AI_CW[$id] - d)) '' "$S"; fi
        LINE+=" $C_UL$hc$C_RST"
    done
}
ai_vtotal() {   # summary line -> LINE (plain width-checked pieces)
    local F=(${AI_M[@all]}) sk="M|@all" s c
    PL_MAX=$((COLUMNS - 1)); pl_reset
    if [[ -z ${AI_M[@all]} ]]; then
        if [[ -n $AI_PID ]] && ((!AI_NSAMPLE)); then t ai_wait; else t ai_none; fi
        pl_fit " $S" "$C_DIM"; LINE=$PL_T; return
    fi
    t ai_t_run; pl_add " $S "; ai_prev "$sk|run"; ai_dcell "${F[2]}" "$PREV" 0 "$C_NS" "$C_DIM" "$C_BOLD"
    PL_T+=$CELL; s=${F[2]}; ((PL_W += ${#s})); [[ $PREV == [0-9]* && $PREV != "${F[2]}" ]] && { s=$((F[2] - PREV)); s=${s#-}; ((PL_W += ${#s} + 1)); }
    t ai_t_wait; pl_add "   $S "; c=$C_DIM; [[ ${F[3]} != - ]] && ((F[3] > 0)) && c=$C_WARN
    ai_prev "$sk|wait"; ai_dcell "${F[3]}" "$PREV" 0 "$C_BAD" "$C_OK" "$c"
    PL_T+=$CELL; s=${F[3]}; ((PL_W += ${#s})); [[ $PREV == [0-9]* && $PREV != "${F[3]}" ]] && { s=$((F[3] - PREV)); s=${s#-}; ((PL_W += ${#s} + 1)); }
    if [[ ${F[5]} != - ]]; then t ai_t_done; printf -v s "   $S" "${F[5]}" "${F[6]}" "${F[18]}"; c=""; ((F[5] > 0)) && c=$C_OK
    else t ai_t_done0; s="   $S"; c=$C_DIM; fi
    pl_add "$s" "$c"
    local o; ai_num o "${F[7]}"; t ai_t_out; printf -v s "   $S" "$o"; pl_add "$s"
    if [[ ${F[4]} != - ]]; then t ai_t_kv; printf -v s "   $S" "${F[4]}"; pct_color c "${F[4]}"; pl_add "$s" "$c"; fi
    if [[ ${F[13]} != - ]]; then t ai_t_gpu; printf -v s "   $S" "${F[13]}"; pct_color c "${F[13]}"; pl_add "$s" "$c"; fi
    if [[ ${F[14]} != - && ${F[15]} != - ]]; then local a b; ai_gib a "${F[14]}"; ai_gib b "${F[15]}"; pl_add "   VRAM $a/$b"; fi
    if [[ ${F[9]} != - ]]; then local x; ai_sec x "${F[9]}"; t ai_t_ttft; printf -v s "   $S" "$x"; pl_add "$s"; fi
    local tot; ai_num tot "${F[12]}"; t ai_t_total; printf -v s "   $S" "$tot"; pl_add "$s" "$C_DIM"
    LINE=$PL_T
}
ai_view() {
    ((READONLY)) && { t readonly; MSG=$S; return 126; }
   # V: vLLM monitor  model > pods (fold), run / wait / done with changes and trends, KV / GPU / VRAM / CPU / MEM, change log
    local sel=0 top=0 h eh n r line out frame=() f sz want="" vid="" start i k
    ((AI_ON)) || { MSG='GPU/vLLM monitoring disabled (--no-ai)'; return; }
    [[ ${R_KIND[SEL]} == pod ]] && want=${R_KEY[SEL]#pod:}
    AI_FAST=1; ai_start
    printf '\e[H\e[2J'
    while :; do
        check_fetch && :; ai_tick
        now_epoch; ((INTERVAL > 0)) && [[ -z $FETCH_PID ]] && ((NOW - LAST_FETCH >= INTERVAL)) && start_fetch
        sz=$(stty size 2>/dev/null) && { LINES=${sz% *}; COLUMNS=${sz#* }; }
        ai_vcols
        eh=0; if ((AI_EVSHOW)); then if ((LINES >= 34)); then eh=7; elif ((LINES >= 22)); then eh=3; fi; fi
        h=$((LINES - 4 - (eh ? eh + 1 : 0))); ((h < 1)) && h=1
        if [[ -z $AI_FOLDDEF ]] && ((${#AI_MLIST[@]})); then   # first data: everything open when it fits, else models only
            AI_FOLDDEF=0; ai_vrows; ((${#VR_KIND[@]} > h)) && AI_FOLDDEF=1
        fi
        [[ -n $want && -n ${AI_PMODEL[$want]} ]] && AI_FOLD[${AI_PMODEL[$want]}]=0
        n=${#VR_KIND[@]}; vid=""   # the row under the cursor (after the last key) before the rows are rebuilt
        if ((n)); then ((sel >= n)) && sel=$((n - 1)); ((sel < 0)) && sel=0; ai_vid "$sel"; vid=$VID; fi
        ai_vrows; n=${#VR_KIND[@]}
        if [[ -n $want ]]; then
            for ((r = 0; r < n; r++)); do [[ ${VR_KIND[r]} == pod* && ${VR_KEY[r]%%|*} == "$want" ]] && { sel=$r; want=""; break; }; done
            ((AI_NSAMPLE)) && want=""
        elif [[ -n $vid ]]; then   # keep the cursor on the same model / pod while rows come and go
            for ((r = 0; r < n; r++)); do ai_vid "$r"; [[ $VID == "$vid" ]] && { sel=$r; break; }; done
        fi
        ((sel >= n)) && sel=$((n - 1)); ((sel < 0)) && sel=0
        ((sel < top)) && top=$sel; ((sel >= top + h)) && top=$((sel - h + 1))
        ((top > n - h)) && top=$((n - h)); ((top < 0)) && top=0

        local age='-' col=""; ((AI_STAMP)) && age=$((NOW - AI_STAMP))
        [[ -n $AI_PID ]] && { t ai_collecting; col="  $S"; }
        local F=(${AI_M[@all]}); [[ -z ${F[0]} ]] && F=(0 0)
        k=${#AI_MLIST[@]}; [[ -n ${AI_MP[$AI_NA]} ]] && ((k--))
        t ai_title; printf -v line "$S" "${CTX}" "${NS:-*}" "$k" "${F[0]}" "${F[1]}" "$age" "$((AI_INTERVAL > 5 ? 5 : AI_INTERVAL))"
        padw line "$line$col   $AI_STATUS" $((COLUMNS - 1))
        out=$'\e[H'"$C_REV$C_BOLD$line$C_RST"$'\e[K\n'
        ai_vtotal; out+="$LINE"$'\e[K\n'
        ai_vhead; out+="$LINE"$'\e[K\n'
        for ((i = 0; i < h; i++)); do
            r=$((top + i))
            if ((r < n)); then ai_vline "$r" $((r == sel)); out+=$LINE
            elif ((i == 0)); then t ai_norows; padw line "   $S" $((COLUMNS - 1)); out+="$C_DIM$line$C_RST"; fi
            out+=$'\e[K\n'
        done
        if ((eh)); then
            t ai_evtitle; line="$G_HR$G_HR $S "; dw k "$line"
            ((k < COLUMNS - 1)) && { printf -v f '%*s' $((COLUMNS - 1 - k)) ''; line+=${f// /$G_HR}; }
            padw line "$line" $((COLUMNS - 1)); out+="$C_DIM$line$C_RST"$'\e[K\n'
            start=$((${#AI_EV[@]} - eh)); ((start < 0)) && start=0
            k=0
            for line in "${AI_EV[@]:start}"; do
                local lv ts tx c tag
                IFS=$'\037' read -r lv ts tx <<<"$line"
                case $lv in bad) c=$C_BAD; tag='[!!]' ;; warn) c=$C_WARN; tag='[! ]' ;; ok) c=$C_OK; tag='[ok]' ;; *) c=""; tag='[  ]' ;; esac
                padw line " $ts $tag $tx" $((COLUMNS - 1)); out+="$C_DIM${line:0:9}$C_END$c${line:9}$C_RST"$'\e[K\n'; ((k++))
            done
            if ((k == 0)); then t ai_evnone; padw line "   $S" $((COLUMNS - 1)); out+="$C_DIM$line$C_RST"$'\e[K\n'; ((k++)); fi
            for ((; k < eh; k++)); do out+=$'\e[K\n'; done
        fi
        if [[ -n $MSG ]]; then padw line " $MSG" $((COLUMNS - 1)); out+="$C_WARN$C_BOLD$line$C_RST"
        else if ((COLUMNS >= 130)); then t ai_hint; else t ai_hint_s; fi; printf -v line "$S" "$AI_SORT"; padw line "$line" $((COLUMNS - 1)); out+="$C_DIM$line$C_RST"; fi
        mapfile -t frame <<<"$out"
        ((${#frame[@]} > LINES)) && frame=("${frame[@]:0:LINES}")
        printf -v out '%s\n' "${frame[@]}"; out=${out%$'\n'}
        printf '\e[?7l%s\e[J\e[?7h' "$out"; MSG=""
        read_key 1 || continue
        local kind=${VR_KIND[sel]} key=${VR_KEY[sel]} fk=""
        case $kind in model) fk=$key ;; gnode) fk="g:$key" ;; pod|podna|xpod) fk=${key#*|} ;; gpu) fk="g:${key%%$'\037'*}" ;; esac
        case $KEY in
            q|ESC) break ;;
            UP|k) ((sel--)) ;; DOWN|j) ((sel++)) ;;
            PGUP) ((sel -= h)) ;; PGDN) ((sel += h)) ;; HOME) sel=0 ;; END) sel=$((n - 1)) ;;
            LEFT|h)
                if [[ $kind == model || $kind == gnode ]] && ai_open "$fk"; then AI_FOLD[$fk]=1
                elif [[ -n $fk ]]; then   # pod / device row: go to its model / worker, like the tree
                    for ((r = sel; r >= 0; r--)); do [[ ${VR_KIND[r]} == model || ${VR_KIND[r]} == gnode ]] && { sel=$r; break; }; done
                fi
                ;;
            RIGHT|l) [[ $kind == model || $kind == gnode ]] && ! ai_open "$fk" && AI_FOLD[$fk]=0 ;;
            ENTER|SPACE)
                if [[ $kind == model || $kind == gnode ]]; then if ai_open "$fk"; then AI_FOLD[$fk]=1; else AI_FOLD[$fk]=0; fi
                elif [[ $kind == pod || $kind == podna ]]; then ai_detail pod "pod:${key%%|*}"
                elif [[ $kind == gpu ]]; then ai_detail node "node:${key%%$'\037'*}"; fi ;;
            d)  case $kind in
                    model) ai_detail model "$key" ;; pod|podna|xpod) ai_detail pod "pod:${key%%|*}" ;;
                    gnode) ai_detail node "node:$key" ;; gpu) ai_detail node "node:${key%%$'\037'*}" ;; *) ai_detail all 'filtered pods' ;;
                esac ;;
            a)  ai_detail all 'filtered pods' ;;
            +|=) AI_FOLD=(); AI_FOLDDEF=0 ;;
            -|_) AI_FOLD=(); AI_FOLDDEF=1 ;;
            o)  case $AI_SORT in name) AI_SORT=load ;; load) AI_SORT=wait ;; *) AI_SORT=name ;; esac ;;
            e)  AI_EVSHOW=$((1 - AI_EVSHOW)) ;;
            L)  f="$TMP/ai-events.log"
                for line in "${AI_EV[@]}"; do
                    local lv ts tx tag; IFS=$'\037' read -r lv ts tx <<<"$line"
                    case $lv in bad) tag='[!!]' ;; warn) tag='[! ]' ;; ok) tag='[ok]' ;; *) tag='[  ]' ;; esac
                    printf '%s %s %s\n' "$ts" "$tag" "$tx"
                done >"$f"
                t ai_evtitle; pager_file "$S" "$f"; printf '\e[H\e[2J' ;;
            t)  if [[ $kind == pod || $kind == podna || $kind == xpod ]] && jump_to_pod "${key%%|*}"; then break; fi ;;
            r)  start_fetch; AI_LAST=0; t refreshing; MSG=$S ;;
            S)  printf -v f '%s/podtree-vllm-%(%Y%m%d-%H%M%S)T.txt' "$HOME" -1
                if { printf 'context=%s namespace=%s\n' "$CTX" "${NS:-*}"
                     ai_vtotal; printf '%s\n' "$LINE"; ai_vhead; printf '%s\n' "$LINE"
                     for ((r = 0; r < n; r++)); do ai_vline "$r" 0; printf '%s\n' "$LINE"; done
                     printf '\n'; for line in "${AI_EV[@]}"; do printf '%s\n' "${line//$'\037'/ }"; done
                   } | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g; s/ *$//' >"$f"; then t saved; printf -v MSG "$S" "$f"; else t save_fail; MSG=$S; fi ;;
        esac
    done
    AI_FAST=0
    DIRTY=1
}
ai_detail() {   # ai_detail SCOPE KEY : scrollable plain report (pod / model / node / all); a = all
    local scope=$1 key=$2 offset=0 lines=() frame=() line out h idx sz f
    printf '\e[H\e[2J'
    while :; do
        check_fetch && :; ai_tick
        now_epoch; ((INTERVAL>0 && NOW-LAST_FETCH>=INTERVAL)) && start_fetch
        sz=$(stty size 2>/dev/null) && { LINES=${sz% *}; COLUMNS=${sz#* }; }
        h=$((LINES-3)); ((h<1)) && h=1
        mapfile -t lines < <(ai_report "$scope" "$key")
        ((offset>${#lines[@]}-h)) && offset=$((${#lines[@]}-h)); ((offset<0)) && offset=0
        padw line " GPU / vLLM   ${CTX}   ${scope}: ${key} ${AI_PID:+[collecting]}" $((COLUMNS-1))
        out=$'\e[H'"${C_REV}${C_BOLD}$line${C_RST}"$'\e[K\n'
        line=' Up/Down PgUp/PgDn scroll | a all | r collect | S save | q/Esc back'
        [[ $UI == ko ]] && line=' ↑↓ PgUp/PgDn 스크롤 | a 전체 | r 수집 | S 저장 | q/Esc 복귀'
        padw line "$line" $((COLUMNS-1))
        out+="$line"$'\e[K\n'
        for ((idx=offset;idx<offset+h;idx++)); do
            line=${lines[idx]}; padw line "$line" $((COLUMNS-1))
            case ${lines[idx]} in \[*|*'MODEL '*) out+="${C_NS}${C_BOLD}$line${C_RST}" ;; *'N/A'*|*'unavailable'*) out+="${C_WARN}$line${C_RST}" ;; *) out+="$line" ;; esac
            out+=$'\e[K\n'
        done
        padw line " ${offset}/${#lines[@]}  ${MSG}" $((COLUMNS-1)); out+="$line"
        mapfile -t frame <<<"$out"
        ((${#frame[@]}>LINES)) && frame=("${frame[@]:0:LINES}")
        printf -v out '%s\n' "${frame[@]}"; out=${out%$'\n'}
        printf '\e[?7l%s\e[J\e[?7h' "$out"; MSG=""
        read_key 1 || continue
        case $KEY in
            q|ESC) break ;; UP|k) ((offset--)) ;; DOWN|j) ((offset++)) ;;
            PGUP) ((offset-=h)) ;; PGDN) ((offset+=h)) ;; HOME) offset=0 ;; END) offset=${#lines[@]} ;;
            a) scope=all; key='filtered pods'; offset=0 ;;
            r) start_fetch; AI_LAST=0 ;;
            S) printf -v f '%s/podtree-ai-%(%Y%m%d-%H%M%S)T.txt' "$HOME" -1
               { printf 'context=%s scope=%s selection=%s\n' "$CTX" "$scope" "$key"; ai_report "$scope" "$key"; } >"$f" && MSG="saved: $f" ;;
        esac
    done
    printf '\e[H\e[2J'
}

# ---------------------------------------------------------------- dashboard
dashboard() {
    local line n i j nodes=0 ready=0 run=0 bad=0 rs=0 node st out worst=() dt=$INTERVAL rc
    ((dt < 2)) && dt=3
    printf '\e[H\e[2J'
    IN_DASH=1; ((PANEL)) || start_fetch      # workloads / requests / node usage are fetched while the dashboard is open
    probe_run host "$TMP/dash.prev"
    while :; do
        check_fetch && :
        now_epoch; ((INTERVAL > 0)) && ((NOW - LAST_FETCH >= INTERVAL)) && start_fetch
        nodes=0; ready=0; run=0; bad=0; rs=0; worst=()
        for node in "${!NODEINFO[@]}"; do ((nodes++)); [[ ${NODEINFO[$node]} == Ready* ]] && ((ready++)); done
        for ((i = 0; i < NPODS; i++)); do
            ((rs += P_RESTARTS[i])); ((bad += P_BAD[i])); [[ ${P_STATUS[i]} == Running && ${P_BAD[i]} == 0 ]] && ((run++))
            ((P_BAD[i])) && worst+=("${P_RESTARTS[i]}"$'\t'"${P_NS[i]}/${P_NAME[i]}"$'\t'"${P_READY[i]}"$'\t'"${P_STATUS[i]}"$'\t'"${P_AGE[i]}")
        done
        t dash; padw line " $S${CTX:+  ctx:$CTX}${NS:+  ns:$NS}   ${LAST_REFRESH}" "$COLUMNS"
        out=$'\e[H'"${C_REV}${C_BOLD}${line}${C_RST}"$'\e[K\n'
        t dash_h; printf -v line "$S" "$dt"; out+="${C_DIM}${line}${C_RST}"$'\e[K\n\n'
        t nodes; line="  ${C_BOLD}${S}${C_END} $nodes"; ((ready < nodes)) && line+=" ${C_BAD}($((nodes - ready)) NotReady)${C_END}"
        t pods; line+="     ${C_BOLD}${S}${C_END} $NPODS   Running $run"; ((bad)) && { t notready; line+="   ${C_BAD}${bad} ${S}${C_END}"; }
        t restarts; line+="   ${S} $rs"; out+="$line"$'\e[K\n\n'
        out+="  ${C_UL}NODE            STATUS                          VERSION    PODS      CPU           MEM           REQ cpu/mem  PRESSURE / TAINTS${C_RST}"$'\e[K\n'
        for node in "${NODE_ORDER[@]}"; do
            st=${NODEINFO[$node]}; local nc=$C_OK; [[ $st != Ready* || -n ${NODE_COND[$node]} ]] && nc=$C_BAD; [[ $st == *SchedulingDisabled* ]] && nc=$C_WARN
            local rq="${NODE_RQC[$node]:--}%/${NODE_RQM[$node]:--}%"; rq=${rq//-1%/-}; rq=${rq//-%/-}
            printf -v line '  %-15s %s%-31s%s %-10s %-9s %-13s %-13s %-12s %s' "$node" "$nc" "${st%%  *}" "$C_END" "${NODE_VER[$node]}" \
                "${NODE_NP[$node]:-0}/${NODE_ALLOC[$node]%%;*}" "${TOPN_CPU[$node]:--}" "${TOPN_MEM[$node]:--}" "$rq" "${NODE_COND[$node]}${NODE_COND[$node]:+ }${NODE_TAINT[$node]%,}"
            out+="$line"$'\e[K\n'
        done
        out+=$'\e[K\n'"  ${C_UL}PROBLEM PODS (by restarts)${C_RST}"$'\e[K\n'
        n=0
        while IFS=$'\t' read -r i j st line rc; do
            [[ -n $j ]] || continue
            local c; status_color c "$line" "$st"
            printf -v line '  %-48s %-7s %s%-20s%s %-5s %s' "$j" "$st" "$c" "$line" "$C_END" "$i" "$rc"; out+="$line"$'\e[K\n'
            ((++n >= 6)) && break
        done < <(printf '%s\n' "${worst[@]}" | sort -t $'\t' -k1,1nr -k2,2)
        ((n == 0)) && out+="  -"$'\e[K\n'
        out+=$'\e[K\n'"  ${C_UL}WORKLOADS SHORT / ROLLING OUT, PVC / JOB / HPA PROBLEMS${C_RST}"$'\e[K\n'
        if ((WL_FAIL)); then t p_na; out+="  $S"$'\e[K\n'
        elif ((${#WL_ITEMS[@]} == 0)); then out+="  -"$'\e[K\n'
        else
            n=0
            for line in "${WL_ITEMS[@]}"; do
                local c=$C_BAD; [[ $line == roll* ]] && c=$C_WARN
                read -r st i j rc <<<"$line"
                printf -v line '  %s%-6s %-7s %-55s %s%s' "$c" "$st" "$i" "$j" "$rc" "$C_END"; out+="$line"$'\e[K\n'
                ((++n >= 6)) && break
            done
        fi
        probe_run host "$TMP/dash.cur"
        out+=$'\e[K\n'"  ${C_UL}THIS HOST ${HOSTNAME%%.*}${C_RST}"$'\e[K\n'
        while IFS= read -r line; do
            case $line in "TCP states"*|"sockstat"*|"TCP counters"*|conntrack*|"host cpu"*|"host load"*|NIC*|FDs*) padw line "  $line" $((COLUMNS - 1)); out+="$line"$'\e[K\n' ;; esac
        done < <(awk -v dt="$dt" -v mode=host -f "$TMP/net.awk" "$TMP/dash.prev" "$TMP/dash.cur")
        mv -f "$TMP/dash.cur" "$TMP/dash.prev"
        out+=$'\e[K\n'"  ${C_UL}RECENT WARNING EVENTS${C_RST}"$'\e[K\n'
        while IFS= read -r line; do padw line "  $line" $((COLUMNS - 1)); out+="${C_WARN}${line}${C_END}"$'\e[K\n'; done < <(
            if [[ -n $NS ]]; then kc get events -n "$NS" --field-selector type=Warning --sort-by=.lastTimestamp 2>/dev/null
            else kc get events -A --field-selector type=Warning --sort-by=.lastTimestamp 2>/dev/null; fi | tail -n 6)
        local dl=() sz; sz=$(stty size 2>/dev/null) && { LINES=${sz% *}; COLUMNS=${sz#* }; }
        mapfile -t dl <<<"$out"                  # never more lines than the screen: the header must not scroll away
        ((${#dl[@]} > LINES)) && dl=("${dl[@]:0:LINES}")
        printf -v out '%s\n' "${dl[@]}"; out=${out%$'\n'}
        printf '\e[?7l%s\e[J\e[?7h' "$out"      # no autowrap: long lines are cut instead of pushing the header away
        read_key "$dt" && case $KEY in ESC|q) break ;; r) start_fetch ;; esac
    done
    IN_DASH=0 DIRTY=1
}


# ---------------------------------------------------------------- change history view (H): live, newest at the bottom
view_history() {
    local out line lines=() n h c f
    printf '\e[H\e[2J'
    while :; do
        check_fetch && :
        now_epoch; ((INTERVAL > 0)) && [[ -z $FETCH_PID ]] && ((NOW - LAST_FETCH >= INTERVAL)) && start_fetch
        local sz; sz=$(stty size 2>/dev/null) && { LINES=${sz% *}; COLUMNS=${sz#* }; }
        h=$((LINES - 3)); ((h < 1)) && h=1
        lines=(); [[ -s $TMP/history.log ]] && mapfile -t lines < <(tail -n "$h" "$TMP/history.log")
        t h_title; padw line " $S${CTX:+  ctx:$CTX}${NS:+  ns:$NS}   ${H_CNT} [!!]/[! ]/[ok]   ${LAST_REFRESH}" "$COLUMNS"
        out=$'\e[H'"${C_REV}${C_BOLD}${line}${C_RST}"$'\e[K\n'
        t h_help; out+="${C_DIM}${S}${C_RST}"$'\e[K\n'
        ((${#lines[@]})) || { t h_empty; out+="  ${C_DIM}${S}${C_RST}"$'\e[K\n'; }
        for line in "${lines[@]}"; do
            case ${line:9:4} in "[!!]") c=$C_BAD ;; "[! ]") c=$C_WARN ;; "[ok]") c=$C_OK ;; *) c=$C_DIM ;; esac
            out+="${C_DIM}${line:0:9}${C_END}${c}${line:9}${C_END}"$'\e[K\n'
        done
        printf '\e[?7l%s\e[J\e[?7h' "$out"
        [[ -n $MSG ]] && { printf '\e[%d;1H\e[1;33m %s\e[0m\e[K' "$LINES" "$MSG"; MSG=""; }
        read_key 1 || continue
        case $KEY in
            ESC|q) break ;;
            SPACE|ENTER) [[ -s $TMP/history.log ]] && { t h_title; pager_file "$S" "$TMP/history.log"; printf '\e[H\e[2J'; } ;;
            S) printf -v f '%s/podtree-history-%(%Y%m%d-%H%M%S)T.log' "$HOME" -1
               if cp "$TMP/history.log" "$f" 2>/dev/null; then t saved; printf -v MSG "$S" "$f"; else t save_fail; MSG=$S; fi ;;
        esac
    done
    DIRTY=1
}

# ---------------------------------------------------------------- problems view (I): every problem in one list, Enter jumps to it
jump_to_pod() {   # jump_to_pod NS/NAME : unfold its groups, drop filters that hide it, select it
    local i G1 G2
    for ((i = 0; i < NPODS; i++)); do [[ ${P_NS[i]}/${P_NAME[i]} == "$1" ]] && break; done
    ((i < NPODS)) || return 1
    match "$i" || { set_filter ""; MARKEDONLY=0; PROBLEMS=0; }
    group_keys "$i"; FOLDED[$G1]=0; [[ -n $G2 ]] && FOLDED[$G2]=0
    SEL_KEY="pod:$1"; build_rows
}
problems_view() {
    local items=() acts=() node info i k it st rest h lt x c rsn kind name
    t i_node; local L_NODE=$S; t i_wl; local L_WL=$S; t i_pod; local L_POD=$S; t i_rs; local L_RS=$S
    t p_cordon; local L_CORD=$S; t i_nrp; local L_NRP=$S; t p_rs1h; local L_RR=$S; t p_short; local L_SHORT=$S; t h_roll; local L_ROLL=$S
    for node in "${NODE_ORDER[@]}"; do            # nodes: NotReady (how long), pressure, cordoned, recently back, pods restarting there
        info=${NODEINFO[$node]}; rsn=${NODE_RSINCE[$node]}; rest=""
        [[ $info != Ready* ]] && { h=""; [[ -n $rsn ]] && hum h "$rsn"; rest+=" ${info%%  *} ${h}"; }
        [[ $info == Ready* && $info == *SchedulingDisabled* ]] && rest+=" $L_CORD"
        [[ -n ${NODE_COND[$node]} ]] && rest+=" ${NODE_COND[$node]}"
        [[ $info == Ready* && -n $rsn ]] && ((rsn < 1800)) && { hum h "$rsn"; rest+=" Ready↑$h"; }
        ((${NODE_NB[$node]:-0})) && rest+="  $L_NRP ${NODE_NB[$node]}"
        ((${NODE_RR[$node]:-0})) && rest+="  $L_RR ${NODE_RR[$node]}"
        [[ -n $rest ]] || continue
        items+=("$L_NODE $node $rest"); acts+=("node:$node")
    done
    for it in "${WL_ITEMS[@]}"; do                # workloads short / rolling, pvc, failed jobs, hpa at max
        read -r st kind name rest <<<"$it"
        if [[ $st == short ]]; then st=$L_SHORT; else st=$L_ROLL; fi
        items+=("$L_WL $kind $name $rest  ($st)"); acts+=("res:$kind:$name")
    done
    local order=()                                 # pods: failing, other bad, pending, then OOM / restarted in the last hour
    for ((i = 0; i < NPODS; i++)); do
        k=3; case ${P_STATUS[i]} in *BackOff*|*Err*|*OOM*|*ExitCode*|*Signal*|*Fail*|*Evict*) k=0 ;; Pending|ContainerCreating|PodInitializing|Init:[0-9]*) k=2 ;; *) k=1 ;; esac
        if ((P_BAD[i])); then order+=("$k $i")
        elif ((${P_OOM[i]:-0})) || { [[ -n ${P_RSEC[i]} ]] && ((P_RSEC[i] <= 3600)); }; then order+=("4 $i"); fi
    done
    while read -r k i; do
        [[ -n $i ]] || continue
        last_term "$i"; h=""; [[ -n ${P_RSEC[i]} ]] && hum h "${P_RSEC[i]}"
        rest="${P_STATUS[i]} ${P_READY[i]}  ${G_RS}${P_RESTARTS[i]}${h:+ ($h)}${LT:+  last=$LT}"
        ((${P_OOM[i]:-0})) && rest+="  OOM(1h) ${P_OOM[i]}"
        x=$L_POD; ((k == 4)) && x=$L_RS
        items+=("$x ${P_NS[i]}/${P_NAME[i]}  $rest  @${P_NODE[i]/#\~/-}"); acts+=("pod:${P_NS[i]}/${P_NAME[i]}")
    done < <(printf '%s\n' "${order[@]}" | sort -k1,1n -k2,2n)
    if ((${#items[@]} == 0)); then t i_none; MSG=$S; return; fi
    t i_title; pick x "$S (${#items[@]})" "${items[@]}" || return
    it=${acts[PICKED]}
    case $it in
        pod:*) jump_to_pod "${it#pod:}" ;;
        node:*) SEL_KEY="node:${it#node:}"; [[ $GROUP == node* ]] || { t selnode; MSG=$S; }; FOLDED[node:${it#node:}]=0; build_rows ;;
        res:*) kind=${it#res:}; name=${kind#*:}; kind=${kind%%:*}
               case $kind in deploy) kind=deployment ;; sts) kind=statefulset ;; ds) kind=daemonset ;; pvc) kind=persistentvolumeclaim ;; hpa) kind=horizontalpodautoscaler ;; esac
               pager "describe $kind $name" kc describe "$kind" "${name#*/}" -n "${name%%/*}" ;;
    esac
}
# ---------------------------------------------------------------- kubectl commands for the selection
show_commands() {
    local kind=${R_KIND[SEL]} key=${R_KEY[SEL]} i=${R_IDX[SEL]} k="kubectl${KARGS[*]:+ ${KARGS[*]}}" ns
    {   case $kind in
            pod) ns=${P_NS[i]}
                 echo "$k logs -n $ns ${P_NAME[i]} -f --tail=$TAIL --all-containers --prefix"
                 echo "$k logs -n $ns ${P_NAME[i]} --previous"
                 echo "$k describe pod -n $ns ${P_NAME[i]}"
                 echo "$k get events -n $ns --field-selector involvedObject.name=${P_NAME[i]} --sort-by=.lastTimestamp"
                 echo "$k exec -it -n $ns ${P_NAME[i]} -c ${P_CNAMES[i]%%,*} -- sh"
                 echo "$k port-forward -n $ns pod/${P_NAME[i]} 8080:${P_PORTS[i]%%,*}"
                 echo "$k get svc,endpoints,ingress,networkpolicy -n $ns"
                 echo "$k debug -it -n $ns ${P_NAME[i]} --image=${DEBUG_IMAGE:-<image-with-tcpdump>} --target=${P_CNAMES[i]%%,*} --profile=netadmin -- tcpdump -nn -i any -c 200 'tcp[tcpflags] & (tcp-syn|tcp-rst) != 0'"
                 [[ -n ${P_IP[i]} ]] && echo "sudo tcpdump -nn -i any -c 200 'host ${P_IP[i]} and tcp[tcpflags] & (tcp-syn|tcp-rst) != 0'      # on node ${P_NODE[i]}"
                 echo "$k delete pod -n $ns ${P_NAME[i]}"
                 [[ ${P_WL[i]} == Deployment/* || ${P_WL[i]} == StatefulSet/* || ${P_WL[i]} == DaemonSet/* ]] && echo "$k rollout restart -n $ns ${P_WL[i],,}" ;;
            node) echo "$k describe node ${key#node:}"; echo "$k get events -A --field-selector involvedObject.kind=Node,involvedObject.name=${key#node:}"
                  echo "$k top node ${key#node:}"; echo "$k cordon ${key#node:}   /   $k uncordon ${key#node:}"; echo "$k drain ${key#node:} --ignore-daemonsets --delete-emptydir-data" ;;
            ns)   ns=${key#ns:}; ns=${ns##*/}; echo "$k get all -n $ns"; echo "$k get events -n $ns --sort-by=.lastTimestamp"; echo "$k describe quota -n $ns" ;;
            wl)   ns=${key#wl:}; ns=${ns%%/*}; echo "$k rollout status -n $ns ${key##*/}"; echo "$k rollout history -n $ns ${key##*/}"; echo "$k describe -n $ns ${key##*/}" ;;
        esac
    } >"$TMP/cmds.txt"
    t k_title; pager_file "$S" "$TMP/cmds.txt"
}

# ---------------------------------------------------------------- small menus / prompts
pick() {   # pick VAR TITLE ITEM...  -> VAR = chosen item, PICKED = its index (in the full list); 1 on Esc
    local var=$1 title=$2; shift 2
    local items=("$@") shown=() cur=0 top=0 buf="" i n h line row
    printf '\e[?25h'
    while :; do
        shown=()
        for i in "${!items[@]}"; do [[ -z $buf || ${items[i],,} == *"${buf,,}"* ]] && shown+=("$i"); done
        n=${#shown[@]}
        ((cur >= n)) && cur=$((n - 1)); ((cur < 0)) && cur=0
        h=$((LINES - 4)); ((h < 3)) && h=3
        ((cur < top)) && top=$cur; ((cur >= top + h)) && top=$((cur - h + 1)); ((top < 0)) && top=0
        t pick_h
        printf '\e[H\e[2J\e[1;7m %s \e[0m  \e[2m%s\e[0m\n' "$title" "$S"
        printf ' > %s\e[K\n' "$buf"
        for ((row = 0; row < h; row++)); do
            i=$((top + row)); ((i < n)) || { printf '\e[K\n'; continue; }
            if ((i == cur)); then printf '\e[7m %-*s\e[0m\n' $((COLUMNS - 2)) "${items[shown[i]]}"; else printf '  %s\e[K\n' "${items[shown[i]]}"; fi
        done
        printf '\e[%d;%dH' 2 $((4 + ${#buf}))
        read_key 0 || continue
        case $KEY in
            ENTER) ((n)) || continue; PICKED=${shown[cur]}; printf -v "$var" '%s' "${items[PICKED]}"; printf '\e[?25l\e[H\e[2J'; DIRTY=1; return 0 ;;
            ESC) printf '\e[?25l\e[H\e[2J'; DIRTY=1; return 1 ;;
            UP|k) ((cur--)) ;; DOWN|j) ((cur++)) ;; PGUP) ((cur -= h)) ;; PGDN) ((cur += h)) ;; HOME) cur=0 ;; END) cur=$((n - 1)) ;;
            BS) buf=${buf%?} ;; SPACE) buf+=" " ;; C-u) buf="" ;;
            *) [[ ${#KEY} == 1 ]] && buf+=$KEY ;;
        esac
    done
}
confirm() {   # confirm PROMPT -> 0 on y/Y
    printf '\e[%d;1H\e[K\e[1;33m%s\e[0m' "$LINES" "$1"
    IFS= read -rsn1 k
    DIRTY=1
    [[ $k == y || $k == Y ]]
}
pick_namespace() {
    [[ ${DACHSTERM_EMBEDDED:-} == 1 ]] && { MSG="DachsTerm: context/namespace fixed; open a new tab to change"; return; }
    local x list=()
    t all_ns; list=("$S")
    while IFS= read -r x; do list+=("${x#namespace/}"); done < <(kc get ns -o name 2>/dev/null)
    t pick_ns; pick x "$S" "${list[@]}" || return
    if ((PICKED == 0)); then NS=""; else NS=$x; fi
    FOLDED=(); SEL_KEY=""; PREV_SIG=(); BASE_RS=(); FIRST_LOAD=1; hist_reset; t ns_switched; printf -v MSG "$S" "${NS:-*}"; draw
    [[ -n $FETCH_PID ]] && { kill "$FETCH_PID" 2>/dev/null; wait "$FETCH_PID" 2>/dev/null; FETCH_PID=""; }
    ai_reset; fetch_sync
}
pick_context() {
    [[ ${DACHSTERM_EMBEDDED:-} == 1 ]] && { MSG="DachsTerm: context/namespace fixed; open a new tab to change"; return; }
    local x list=() a=() i
    while IFS= read -r x; do list+=("$x"); done < <(kc config get-contexts -o name 2>/dev/null)
    ((${#list[@]})) || return
    t pick_ctx; pick x "$S" "${list[@]}" || return
    for ((i = 0; i < ${#KARGS[@]}; i++)); do [[ ${KARGS[i]} == --context ]] && { ((i++)); continue; }; a+=("${KARGS[i]}"); done
    KARGS=("${a[@]}" --context "$x"); CTX=$x; FOLDED=(); SEL_KEY=""; PREV_SIG=(); BASE_RS=(); MARK=(); FIRST_LOAD=1 ; hist_reset
    t ctx_switched; printf -v MSG "$S" "$x"; draw
    [[ -n $FETCH_PID ]] && { kill "$FETCH_PID" 2>/dev/null; wait "$FETCH_PID" 2>/dev/null; FETCH_PID=""; }
    ai_reset; fetch_sync
}
pick_container_logs() {   # c: choose a container of the selected pod, then its logs
    local i=${R_IDX[SEL]} x list=() c
    [[ ${R_KIND[SEL]} == pod ]] || { t selpod; MSG=$S; return; }
    t all_ctr; list=("$S")
    IFS=',' read -ra c <<<"${P_INAMES[i]}${P_CNAMES[i]}"
    for x in "${c[@]}"; do [[ -n $x ]] && list+=("${x%%:*}"); done
    t pick_ctr; pick x "$S ${P_NS[i]}/${P_NAME[i]}" "${list[@]}" || return
    if ((PICKED == 0)); then view_logs "$i"; else view_logs "$i" "" "ctr=$x"; fi
}

# ---------------------------------------------------------------- shell / write actions
shell_into() {
    ((READONLY)) && { t readonly; MSG=$S; return 126; }
    confirm "exec shell: context=$CTX target=${R_KEY[SEL]:-none}. Continue? [y/N]" || return

    local i=${R_IDX[SEL]} rc
    [[ ${R_KIND[SEL]} == pod ]] || { t selpod; MSG=$S; return; }
    leave_screen
    trap ':' INT
    t exec_h; printf "\e[1m$S\e[0m\n" "${P_NS[i]}/${P_NAME[i]}"
    kc exec -it "${P_NAME[i]}" -n "${P_NS[i]}" -c "${P_CNAMES[i]%%,*}" -- sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'
    rc=$?
    ((rc != 0)) && { t exit_rc; printf "\n$S" "$rc"; IFS= read -r _; }
    trap 'exit 130' INT
    enter_screen
}
run_action() {   # run_action LABEL kubectl-args... : run, show the first output line as the message
    local label=$1 out; shift
    out=$(kc "$@" 2>&1 | head -n 1)
    t done_; printf -v MSG "$S" "${out:-$label}"
    start_fetch
}
delete_pod() {
    local i=${R_IDX[SEL]}
    ((READONLY)) && { t readonly; MSG=$S; return; }
    [[ ${R_KIND[SEL]} == pod ]] || { t selpod; MSG=$S; return; }
    t confirm_del; printf -v S "$S" "${P_NS[i]}/${P_NAME[i]}"
    confirm "$S" || { t cancelled; MSG=$S; return; }
    run_action "delete ${P_NAME[i]}" delete pod "${P_NAME[i]}" -n "${P_NS[i]}" --wait=false
}
rollout_restart() {
    local kind=${R_KIND[SEL]} key=${R_KEY[SEL]} i=${R_IDX[SEL]} ns wl
    ((READONLY)) && { t readonly; MSG=$S; return; }
    case $kind in
        pod) ns=${P_NS[i]}; wl=${P_WL[i]} ;;
        wl)  ns=${key#wl:}; ns=${ns%%/*}; wl=${key##*/} ;;
        *) t selpod; MSG=$S; return ;;
    esac
    case $wl in Deployment/*|StatefulSet/*|DaemonSet/*) ;; *) t no_owner; MSG=$S; return ;; esac
    t confirm_rr; printf -v S "$S" "$ns/$wl"
    confirm "$S" || { t cancelled; MSG=$S; return; }
    run_action "rollout restart $wl" rollout restart -n "$ns" "${wl,,}"
}
cordon_toggle() {
    local key=${R_KEY[SEL]} node
    ((READONLY)) && { t readonly; MSG=$S; return; }
    [[ ${R_KIND[SEL]} == node && $key != "node:~" ]] || { t selnode; MSG=$S; return; }
    node=${key#node:}
    if [[ ${NODEINFO[$node]} == *SchedulingDisabled* ]]; then
        t confirm_uncordon; printf -v S "$S" "$node"; confirm "$S" || { t cancelled; MSG=$S; return; }
        run_action "uncordon $node" uncordon "$node"
    else
        t confirm_cordon; printf -v S "$S" "$node"; confirm "$S" || { t cancelled; MSG=$S; return; }
        run_action "cordon $node" cordon "$node"
    fi
}
save_tree() {   # S in the tree: plain snapshot of every visible row
    local ts f r
    printf -v ts '%(%Y%m%d-%H%M%S)T' -1 2>/dev/null || ts=$(date +%Y%m%d-%H%M%S)
    f=~/podtree-tree-${ts}.txt
    {   echo "podtree $ts  ctx:${CTX:--}  ns:${NS:-*}  group:${GROUP}  filter:${FILTER:--}"
        for ((r = 0; r < ${#R_KIND[@]}; r++)); do render_row "$r" 0; printf '%s\n' "${PLAIN%"${PLAIN##*[! ]}"}"; done
    } >"$f" 2>/dev/null && { t saved; printf -v MSG "$S" "$f"; } || { t save_fail; MSG=$S; }
}

# ---------------------------------------------------------------- input
PENDING=""
read_key() {   # read_key TIMEOUT  (0 = wait) ; sets KEY ; returns 1 on timeout / signal
    local k rest c seq rc tmo=${1:-1}
    if [[ -n $PENDING ]]; then
        k=$PENDING; PENDING=""
    else
        if [[ $tmo != 0 ]]; then IFS= read -rsn1 -t "$tmo" k; rc=$?; else IFS= read -rsn1 k; rc=$?; fi
        if ((rc != 0)); then ((rc > 128)) && return 1; exit 0; fi
    fi
    case $k in
        $'\e')
            if IFS= read -rsn1 -t 0.05 rest; then
                if [[ $rest == "[" || $rest == "O" ]]; then
                    seq=$rest
                    while IFS= read -rsn1 -t 0.05 c; do
                        seq+=$c
                        case $c in [A-Za-z~]) break ;; esac
                        ((${#seq} > 8)) && break
                    done
                    case $seq in
                        "[A"|"OA") KEY=UP ;;   "[B"|"OB") KEY=DOWN ;;   "[C"|"OC") KEY=RIGHT ;;   "[D"|"OD") KEY=LEFT ;;
                        "[H"|"OH"|"[1~"|"[7~") KEY=HOME ;;   "[F"|"OF"|"[4~"|"[8~") KEY=END ;;
                        "[5~") KEY=PGUP ;;   "[6~") KEY=PGDN ;;   "[3~") KEY=DEL ;;   *) KEY=NONE ;;
                    esac
                else
                    KEY=ESC; PENDING=$rest
                fi
            else
                KEY=ESC
            fi ;;
        "") KEY=ENTER ;;
        " ") KEY=SPACE ;;
        $'\t') KEY=TAB ;;
        $'\x7f'|$'\b') KEY=BS ;;
        $'\x15') KEY=C-u ;;
        [[:cntrl:]]) KEY=NONE ;;
        *) KEY=$k ;;
    esac
    return 0
}
read_line() {   # read_line VAR LABEL [INITIAL] [ROW]  small line editor on the bottom row (multibyte ok)
    local buf=$3 label=$2 row=${4:-$LINES}
    printf '\e[?25h'
    while :; do
        printf '\e[%d;1H\e[K\e[1m%s\e[0m%s' "$row" "$label" "$buf"
        read_key 0 || { ((INT_HIT)) && { printf '\e[?25l'; return 1; }; continue; }
        case $KEY in
            ENTER) printf '\e[?25l'; printf -v "$1" '%s' "$buf"; return 0 ;;
            ESC) printf '\e[?25l'; return 1 ;;
            BS) buf=${buf%?} ;;
            SPACE) buf+=" " ;;
            C-u) buf="" ;;
            *) [[ ${#KEY} == 1 ]] && buf+=$KEY ;;
        esac
    done
}
prompt_filter() {   # incremental: the tree is filtered while you type; Enter keeps it, Esc restores the old filter
    local old=$FILTER buf=$FILTER r
    printf '\e[?25h'
    while :; do
        set_filter "$buf"; build_rows
        if [[ -n $FILTER ]]; then
            for ((r = 0; r < ${#R_KIND[@]}; r++)); do [[ ${R_KIND[r]} == pod ]] && { SEL=$r; break; }; done
            clamp
        fi
        draw
        t filter_p; printf '\e[%d;1H\e[K\e[1m%s\e[0m%s\e7' "$LINES" "$S" "$buf"
        t pods; printf '\e[2m   %d %s   ' "$MATCHED" "$S"; t filter_h; printf '%s\e[0m\e8' "$S"
        read_key 0 || continue
        case $KEY in
            ENTER) break ;;
            ESC) buf=$old; break ;;
            BS) buf=${buf%?} ;;
            SPACE) buf+=" " ;;
            C-u) buf="" ;;
            *) [[ ${#KEY} == 1 ]] && buf+=$KEY ;;
        esac
    done
    printf '\e[?25l'
    set_filter "$buf"; build_rows
}

handle_key() {
    local n=${#R_KIND[@]} body_h=$BODY_H kind="" key="" i=-1 pat pk
    ((n)) && { kind=${R_KIND[SEL]}; key=${R_KEY[SEL]}; i=${R_IDX[SEL]}; }
    MSG=""
    case $KEY in
        q|Q) exit 0 ;;
        UP|k) ((SEL--)); clamp ;;
        DOWN|j) ((SEL++)); clamp ;;
        PGUP) ((SEL -= body_h)); clamp ;;
        PGDN) ((SEL += body_h)); clamp ;;
        HOME) SEL=0; clamp ;;
        END) SEL=$((n - 1)); clamp ;;
        LEFT|h) if [[ $kind != pod && -n $kind ]] && is_expanded "$key"; then FOLDED[$key]=1; build_rows; else parent; fi ;;
        RIGHT|l)
            if [[ $kind == pod ]]; then view_logs "$i"
            elif [[ -n $kind ]] && ! is_expanded "$key"; then FOLDED[$key]=0; build_rows
            else ((SEL++)); clamp; fi ;;
        ENTER) if [[ $kind == pod ]]; then view_logs "$i"; elif [[ -n $kind ]]; then toggle "$key"; fi ;;
        L)  if [[ $kind == pod ]]; then
                t logpat_p; read_line pat "$S" && [[ -n $pat ]] && view_logs "$i" "$pat"
            elif [[ -n $kind ]]; then logs_under_row; fi ;;
        p) if [[ $kind == pod ]]; then view_logs "$i" "" prev; else t selpod; MSG=$S; fi ;;
        c) pick_container_logs ;;
        m)  pods_under "$SEL"
            if [[ $kind == pod ]]; then pk="${P_NS[i]}/${P_NAME[i]}"; if [[ -n ${MARK[$pk]+x} ]]; then unset "MARK[$pk]"; else MARK[$pk]=1; fi; ((SEL++)); clamp
            else local all=1 j; for j in "${UNDER[@]}"; do [[ -n ${MARK[${P_NS[j]}/${P_NAME[j]}]+x} ]] || all=0; done
                 for j in "${UNDER[@]}"; do pk="${P_NS[j]}/${P_NAME[j]}"; if ((all)); then unset "MARK[$pk]"; else MARK[$pk]=1; fi; done; fi
            t marked; printf -v MSG "$S" "${#MARK[@]}"; ((MARKEDONLY)) && build_rows ;;
        M) logs_marked ;;
        u) MARK=(); MARKEDONLY=0; build_rows ;;
        \*) MARKEDONLY=$((1 - MARKEDONLY)); build_rows ;;
        e) view_events ;;
        E) live_events ;;
        v) view_relations ;;
        N) view_netstat ;;
        T) capture ;;
        D) dashboard ;;
        V) ai_view ;;
        H) view_history ;;
        I) problems_view ;;
        P) port_forward ;;
        K) show_commands ;;
        SPACE) [[ -n $kind && $kind != pod ]] && toggle "$key" ;;
        TAB) DETAIL=$((1 - DETAIL)); if ((DETAIL)); then t detail_on; else t detail_off; fi; MSG=$S ;;
        w|W) PANEL=$((1 - PANEL)); if ((PANEL)); then t panel_on; MSG=$S; start_fetch; else t panel_off; MSG=$S; fi ;;
        +|=) FOLDED=(); DEFAULT_FOLDED=0; build_rows ;;
        -|_) FOLDED=(); DEFAULT_FOLDED=1; build_rows ;;
        d) selected_resource && pager "describe $RES_TITLE" kc describe "${RES_ARGS[@]}" ;;
        y) selected_resource && pager "yaml $RES_TITLE" kc get "${RES_ARGS[@]}" -o yaml ;;
        s) shell_into ;;
        /) prompt_filter ;;
        ESC) if [[ -n $FILTER || $PROBLEMS == 1 || $MARKEDONLY == 1 ]]; then set_filter ""; PROBLEMS=0; MARKEDONLY=0; build_rows; fi ;;
        !) PROBLEMS=$((1 - PROBLEMS)); build_rows ;;
        g)  case $GROUP in node,ns) GROUP=ns ;; ns) GROUP=ns,wl ;; ns,wl) GROUP=node ;; *) GROUP=node,ns ;; esac
            FOLDED=(); regroup; t group; printf -v MSG "$S" "${GROUP/,/>}" ;;
        o)  case $SORT in name) SORT=status ;; status) SORT=restarts ;; restarts) SORT=age ;; *) SORT=name ;; esac
            regroup; t sort; printf -v MSG "$S" "$SORT" ;;
        i) WIDE=$((1 - WIDE)); if ((WIDE)); then t wide_on; else t wide_off; fi; MSG=$S ;;
        t)  TOPON=$((1 - TOPON)); if ((TOPON)); then t top_on; MSG=$S; start_fetch; else t top_off; MSG=$S; fi ;;
        r) t refreshing; MSG=$S; start_fetch; AI_LAST=0 ;;
        S) save_tree ;;
        DEL) delete_pod ;;
        R) rollout_restart ;;
        X) cordon_toggle ;;
        n) pick_namespace ;;
        C) pick_context ;;
        a) ASCII=$((1 - ASCII)); set_glyphs ;;
        \\) if [[ $UI == ko ]]; then UI=en; else UI=ko; fi ;;
        \?) show_help ;;
    esac
    DIRTY=1
}
selected_resource() {   # sets RES_ARGS / RES_TITLE for describe / get, or returns 1
    local kind=${R_KIND[SEL]} key=${R_KEY[SEL]} i=${R_IDX[SEL]} ns
    case $kind in
        pod) RES_ARGS=(pod "${P_NAME[i]}" -n "${P_NS[i]}"); RES_TITLE="pod ${P_NS[i]}/${P_NAME[i]}" ;;
        node) [[ $key == "node:~" ]] && { t notnode; MSG=$S; return 1; }
              RES_ARGS=(node "${key#node:}"); RES_TITLE="node ${key#node:}" ;;
        ns) ns=${key#ns:}; ns=${ns##*/}; RES_ARGS=(namespace "$ns"); RES_TITLE="namespace $ns" ;;
        wl) ns=${key#wl:}; ns=${ns%%/*}; [[ ${key##*/} == Pod/* ]] && { RES_ARGS=(pod "${key##*/Pod/}" -n "$ns"); RES_TITLE="pod $ns/${key##*/Pod/}"; return; }
            RES_ARGS=("${key##*/}" -n "$ns"); RES_TITLE="${key#wl:}" ;;
        *) return 1 ;;
    esac
}

# ---------------------------------------------------------------- main
CTX=${KCTX:-$(kc config current-context 2>/dev/null)}
((READONLY)) && AI_ON=0 # proxy-based metrics are disabled in query mode
enter_screen
t loading; MSG=$S; draw
fetch_sync; MSG=""
while :; do
    # Collection must progress even while a navigation key is held down.
    check_fetch && DIRTY=1
    ai_tick
    now_epoch
    ((INTERVAL > 0)) && [[ -z $FETCH_PID ]] && ((NOW - LAST_FETCH >= INTERVAL)) && start_fetch && DIRTY=1
    ((DIRTY)) && draw
    if read_key 1; then
        handle_key
    fi
done
