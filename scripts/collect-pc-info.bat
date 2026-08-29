@echo off
REM collect-pc-info.bat — запускает collect-pc-info.ps1 и кладёт результат
REM в указанную (в т.ч. сетевую) папку. Требует прав администратора — часть
REM данных (серийный номер и т.п.) без них может не собраться, но скрипт
REM не упадёт, просто оставит эти поля пустыми.
REM
REM ИСПОЛЬЗОВАНИЕ:
REM   collect-pc-info.bat                             -- сохранит рядом с батником
REM   collect-pc-info.bat \\server\share\inventory     -- сохранит в сетевую папку
REM (можно перетащить .bat в ярлык с указанным сетевым путём как аргументом —
REM  тогда каждый следующий двойной клик будет сохранять сразу на сервер)

setlocal
set "OUTDIR=%~1"
if "%OUTDIR%"=="" set "OUTDIR=%~dp0"

REM %~dp0 (папка со скриптом) всегда заканчивается на "\" — если такой путь
REM передать в кавычках как последний аргумент, Windows воспримет \" как
REM экранированную кавычку, а не конец строки, и путь исказится. Убираем
REM завершающий слеш, если он есть.
if "%OUTDIR:~-1%"=="\" set "OUTDIR=%OUTDIR:~0,-1%"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0collect-pc-info.ps1" -OutputPath "%OUTDIR%"

echo.
pause
