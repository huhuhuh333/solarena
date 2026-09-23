@echo off
rem Cloudflare quick tunnel to the local SolArena server (port 8787).
rem The public https://*.trycloudflare.com address is printed into
rem server\data\tunnel.log and changes every time the tunnel restarts.
cd /d C:\Users\WIN11\Desktop\hoodarena
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --no-autoupdate --protocol http2 --url http://localhost:8787 > server\data\tunnel.log 2>&1
echo %DATE% %TIME% tunnel-exit=%ERRORLEVEL% >> server\data\exitcode.log
