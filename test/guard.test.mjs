// Table test for the read-only classifier. Run: node --test test/guard.test.mjs  (Node 22.18+/24 strips types)
import test from "node:test";
import assert from "node:assert/strict";
import { explainUnsafe, guardVerdict, isReadOnlyCommand } from "../src/guard.ts";

const SAFE = [], UNSAFE = [];
const safe = (...c) => SAFE.push(...c), unsafe = (...c) => UNSAFE.push(...c);
safe("ls -la","cat /etc/hosts","grep '>' f","grep -rn 'foo|bar' src | head -20","tail -n 100 logs/error.log | grep ERROR",
 "sudo cat /etc/x","sudo -n -u postgres cat /x","docker compose logs --tail 50 web","docker ps -a","docker logs -f web","docker stats --no-stream",
 "docker compose -f a.yml ps","sed -n 1,5p f","sed -n '/ERROR/p' f","sed '1d' f","sed -E 's/a(b)/\\1/g' f","awk '{print $1}' f","awk -F'|' '{print $2}' f",
 "awk '$3>=10' f","curl -s http://x/health","curl -sSI https://x","curl -X GET http://x","curl --request HEAD http://x","git status","git log --oneline -5",
 "git diff HEAD~1","git branch -a","git branch --list 'f*'","git tag -l","git remote -v","git config --get user.name","git stash list","git -C /srv/app status",
 "ls; pwd","FOO=1 ls","timeout 5 tail -f x","env FOO=1 ls","time ls","nice -n 5 du -sh .","systemctl status nginx","systemctl is-active --quiet x",
 "systemctl list-units --type=service --no-pager","service nginx status","kubectl get pods -n prod","kubectl -n x logs pod/a --tail 10","kubectl config current-context",
 "npm ls","pip list","python3 --version","node -v","uname -a && uptime","ps aux | grep nginx","find . -name '*.py' -mtime -1","find /var/log -type f -size +1M",
 "ip addr show","ip -br a","ss -tulpn","df -h; free -m","echo hi 2>&1","ls /nonexistent 2>/dev/null","cat < file","grep x <<< 'abc'","journalctl -u x --since today -n 50",
 "cat <<'EOF'\nhello $(not run)\nEOF","ls\npwd\nwhoami","top -b -n 1","date +%s","hostname -f","sort -u f | uniq -c","jq . f.json","dmesg -T","mount","test -f x && echo yes","[ -d /x ] || echo no",
 "echo 'a;b' | cut -d';' -f1","# just a comment\nls","/usr/bin/cat x","sudo -n systemctl status x","uniq f","tree -L 2","pgrep -f nginx","printenv HOME","docker inspect web","docker container ls","docker network ls","docker volume inspect v","pip3 freeze");
unsafe("cat a > b","cat a >> b","echo x >| f","echo x &> f","echo $(rm -rf /)","echo `id`","echo \"$(id)\"","grep x f | tee out","sudo -u postgres psql","sudo rm x","sudo cat <(ls)",
 "find . -name x -delete","find . -exec rm {} \;","find . -fprint /tmp/x","git branch -D x","git branch newb","git tag v1","git status && rm x","git commit -m x","git config user.name x","git -c core.pager=x log",
 "git diff --output=x","git remote add o u","git stash","git push","docker compose down","docker compose up -d","docker exec -it web sh","docker run x","docker rm x","docker stats","docker compose config -o x",
 "sed -i s/a/b/ f","sed -i.bak s/a/b/ f","sed -n 'w out' f","sed 's/a/b/w out' f","sed 's/a/b/e' f","sed -f s.sed f","sed -n '1e ls' f","awk '{print > \"x\"}' f","awk '{system(\"id\")}' f","awk 'BEGIN{\"ls\" | getline}'",
 "awk '{print | \"sh\"}' f","awk '$3 > 10' f","curl -X POST http://x","curl -d a=b http://x","curl -o out http://x","curl -O http://x","curl --data-binary @f http://x","curl -T f http://x","curl -XDELETE http://x","wget http://x",
 "ls; reboot","ls && reboot","ls | sh","ls &","ls & reboot","kubectl delete pod x","kubectl apply -f x","kubectl exec x -- sh","systemctl restart x","systemctl stop x","systemctl daemon-reload","service nginx restart",
 "npm install","npm run build","pip install x","python3 x.py","python -c 'print(1)'","node app.js","psql -c 'select 1'","mysql -e 'x'","redis-cli get x","eval ls","exec ls","source x",". x","xargs rm","rm -rf x","mv a b","cp a b","touch x","mkdir x","chmod +x f","tee x","dd if=a of=b",
 "( ls )","{ ls; }","ls $(pwd)","diff <(ls) <(ls)","echo x > /etc/f","echo x 2>f","cat a 2>>log","sort -o out f","tree -o out","ip link set eth0 down","ip addr add 1.2.3.4 dev eth0","ss -K","dmesg -c","journalctl --vacuum-size=1M","hostname newname","date -s 12:00","date 010112002020",
 "top","uniq a b","mount /dev/x /mnt","less +!rm f","rg --pre sh x","file -C","command ls","for i in 1 2; do ls; done","if true; then ls; fi","FOO=$(id) ls","PATH=/tmp ls","LD_PRELOAD=x ls","env sh","env -S x ls","timeout ls","nohup ls","bash -c ls","sh -c ls","ls \\","echo 'unterminated","cat <<EOF\n$(id)\nEOF","cat <<EOF\nnoend","ls ; ; rm x", "case x in x) ls;; esac","git log; git push","find . $X","sed -n \"$S\" f","docker -H tcp://x ps; docker rm a","kubectl get pods; kubectl delete pod x","echo x\nrm y","echo a |& tee f","git ls-remote origin | sh");

test("read-only commands are accepted", () => {
  for (const command of SAFE) assert.equal(isReadOnlyCommand(command), true, command);
});
test("anything else needs confirmation", () => {
  for (const command of UNSAFE) assert.equal(isReadOnlyCommand(command), false, command);
});
test("explainUnsafe names the first offending part", () => {
  assert.equal(explainUnsafe("ls; reboot"), "Not recognized as read-only: reboot");
  assert.equal(explainUnsafe("git status && rm x"), "Not recognized as read-only: rm x");
  assert.equal(explainUnsafe("cat a > b"), "Not recognized as read-only: cat a > b");
  assert.equal(explainUnsafe("ls -la"), "");
});
test("guard verdicts", () => {
  assert.equal(guardVerdict(undefined, "write"), "allow");
  for (const tool of ["read", "grep", "find", "ls"]) { assert.equal(guardVerdict("readonly", tool), "allow"); assert.equal(guardVerdict("confirm", tool), "allow"); }
  assert.equal(guardVerdict("readonly", "write"), "block");
  assert.equal(guardVerdict("readonly", "edit"), "block");
  assert.equal(guardVerdict("confirm", "write"), "confirm");
  assert.equal(guardVerdict("confirm", "bash", "ls"), "confirm");
  assert.equal(guardVerdict("readonly", "bash", "ls"), "allow");
  assert.equal(guardVerdict("readonly", "bash", "rm x"), "confirm");
  assert.equal(guardVerdict("readonly", "bash"), "confirm");
});
