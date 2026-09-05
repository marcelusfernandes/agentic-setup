#!/usr/bin/env bash
# _lib.sh — private helpers shared by next.sh / blocked.sh / status.sh.
# Not a standalone script: no shebang execution, sourced only. Requires common.sh/json.sh/state.sh already sourced.

# read_block_list <file> <key> -> items of a block-style YAML list (e.g. "files:\n  - a\n  - b"), one per line.
read_block_list() {
  awk -v k="$2" '
    NR==1 { if ($0!="---") exit; infm=1; next }
    infm && $0=="---" { exit }
    infm && found && $0 ~ /^[ \t]*-[ \t]*/ { line=$0; sub(/^[ \t]*-[ \t]*/,"",line); gsub(/^"|"$/,"",line); print line; next }
    infm && found { found=0 }
    infm && $0 ~ "^"k":" { found=1; next }
  ' "$1"
}

# key_for_file <task-file> -> issue number if synced, else "<epic>:<local_id>"
key_for_file() {
  local f="$1" issue epic lid
  issue="$(fm_get "$f" issue)"
  epic="$(fm_get "$f" epic)"
  lid="$(fm_get "$f" local_id)"
  if [ -n "$issue" ] && [ "$issue" != "null" ]; then printf '%s\n' "$issue"
  else printf '%s:%s\n' "$epic" "$lid"; fi
}

# resolve_dep <from-epic> <dep-token> -> prints the resolved key, or nothing (exit 1) if unresolvable.
resolve_dep() {
  local epic="$1" dep="$2" f hit p
  f="$(find_task_file "$epic" "$dep" 2>/dev/null || true)"
  if [ -n "$f" ] && [ -f "$f" ]; then key_for_file "$f"; return 0; fi
  case "$dep" in
    ''|*[!0-9]*) return 1 ;;
  esac
  hit="$(find_task_by_issue "$dep" 2>/dev/null || true)"
  if [ -n "$hit" ]; then
    p="$(printf '%s' "$hit" | awk '{print $2}')"
    [ -f "$p" ] && { key_for_file "$p"; return 0; }
  fi
  return 1
}

# build_graph <slug-or-empty> <nodes-out> <edges-out> <unresolved-out>
# nodes: key\tepic\tpath\tissue\tlocal_id\tstatus\tname
# edges: dep_key\ttask_key           (dep must complete before task)
# unresolved: task_key\tdep_token    (dependency token that could not be resolved to a known task)
build_graph() {
  local slug="$1" nodes="$2" edges="$3" unresolved="$4" ed dirs d f key st name issue lid dep dk
  : > "$nodes"; : > "$edges"; : > "$unresolved"
  if [ -n "$slug" ]; then dirs="$(epic_dir "$slug")"; else dirs="$(epics_dir)"/*; fi
  for d in $dirs; do
    [ -d "$d/tasks" ] || continue
    ed="$(basename "$d")"
    for f in "$d"/tasks/*.md; do
      [ -f "$f" ] || continue
      key="$(key_for_file "$f")"
      st="$(fm_get "$f" status)"
      name="$(fm_get "$f" name)"
      issue="$(fm_get "$f" issue)"
      lid="$(fm_get "$f" local_id)"
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$key" "$ed" "$f" "$issue" "$lid" "$st" "$name" >> "$nodes"
      fm_list "$f" depends_on | while IFS= read -r dep; do
        [ -n "$dep" ] || continue
        if dk="$(resolve_dep "$ed" "$dep")"; then
          printf '%s\t%s\n' "$dk" "$key" >> "$edges"
        else
          printf '%s\t%s\n' "$key" "$dep" >> "$unresolved"
        fi
      done
    done
  done
}

# kahn_check <nodes-file> <edges-file> -> prints "OK" (exit 0) or "CYCLE a -> b -> a" (exit 1)
kahn_check() {
  awk -v nodesfile="$1" '
    BEGIN {
      while ((getline line < nodesfile) > 0) {
        if (line=="") continue
        split(line, f, "\t"); k=f[1]
        if (!(k in seen)) { seen[k]=1; order[++nn]=k }
      }
    }
    { from=$1; to=$2; if (from=="" || to=="") next
      idx = ++cnt[from]; adj[from, idx] = to; adjn[from]++
      indeg[to]++
      if (!(from in seen)) { seen[from]=1; order[++nn]=from }
      if (!(to in seen)) { seen[to]=1; order[++nn]=to }
    }
    END {
      for (i=1;i<=nn;i++) if (!(order[i] in indeg)) indeg[order[i]]=0
      qn=0
      for (i=1;i<=nn;i++) if (indeg[order[i]]==0) q[++qn]=order[i]
      head=1; processed=0
      while (head<=qn) {
        cur=q[head++]; processed++; done[cur]=1
        m=adjn[cur]
        for (i=1;i<=m;i++) {
          t=adj[cur, i]
          indeg[t]--
          if (indeg[t]==0) q[++qn]=t
        }
      }
      if (processed==nn) { print "OK"; exit 0 }
      # find one cycle among the unprocessed ("remaining") nodes via multi-source colored DFS
      for (s=1; s<=nn; s++) {
        start=order[s]
        if (start in done) continue
        if (start in visited) continue
        spn=1; sp[1]=start; onstack[start]=1; visited[start]=1
        while (spn>0) {
          cur=sp[spn]; advanced=0
          m=adjn[cur]
          for (i=1;i<=m;i++) {
            t=adj[cur, i]
            if (t in done) continue
            if (t in onstack) {
              idx=0
              for (j=1;j<=spn;j++) if (sp[j]==t) { idx=j; break }
              cyc=sp[idx]
              for (j=idx+1;j<=spn;j++) cyc = cyc " -> " sp[j]
              cyc = cyc " -> " t
              print "CYCLE " cyc
              exit 1
            }
            if (!(t in visited)) { visited[t]=1; spn++; sp[spn]=t; onstack[t]=1; advanced=1; break }
          }
          if (!advanced) { delete onstack[cur]; spn-- }
        }
      }
      print "CYCLE (unresolved)"
      exit 1
    }
  ' "$2"
}

estimate_weight() { case "$1" in S) printf 0 ;; M) printf 1 ;; L) printf 2 ;; *) printf 1 ;; esac; }

# epoch_of <iso8601 "YYYY-MM-DDTHH:MM:SSZ"> -> seconds since epoch.
# Pure integer arithmetic (Howard Hinnant's days_from_civil) — no `date -d`/`date -j`, so it
# behaves identically on GNU and BSD systems.
epoch_of() {
  local iso="${1:-}" y m d hh mm ss yy era yoe mp doy doe days
  [ -n "$iso" ] || { printf '0\n'; return 0; }
  y="${iso:0:4}"; m="${iso:5:2}"; d="${iso:8:2}"; hh="${iso:11:2}"; mm="${iso:14:2}"; ss="${iso:17:2}"
  case "$y$m$d$hh$mm$ss" in *[!0-9]*|"") printf '0\n'; return 0 ;; esac
  y=$((10#$y)); m=$((10#$m)); d=$((10#$d)); hh=$((10#$hh)); mm=$((10#$mm)); ss=$((10#$ss))
  yy=$y; [ "$m" -le 2 ] && yy=$((yy-1))
  era=$((yy/400)); yoe=$((yy-era*400)); mp=$(((m+9)%12))
  doy=$(( (153*mp+2)/5 + d - 1 ))
  doe=$(( yoe*365 + yoe/4 - yoe/100 + doy ))
  days=$(( era*146097 + doe - 719468 ))
  printf '%s\n' $(( days*86400 + hh*3600 + mm*60 + ss ))
}

# age_human <iso8601> -> "3m" / "2h" / "5d" relative to now (best-effort, floors to the unit)
age_human() {
  local then now secs
  then="$(epoch_of "$1")"; now=$(date -u +%s); secs=$(( now - then ))
  [ "$secs" -lt 0 ] && secs=0
  if [ "$secs" -lt 3600 ]; then printf '%sm\n' $((secs/60))
  elif [ "$secs" -lt 86400 ]; then printf '%sh\n' $((secs/3600))
  else printf '%sd\n' $((secs/86400)); fi
}
