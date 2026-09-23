@echo off
cd /d C:\Users\WIN11\Desktop\hoodarena
npm run server >> server\data\server-task.log 2>&1
echo %DATE% %TIME% node-exit=%ERRORLEVEL% >> server\data\exitcode.log
