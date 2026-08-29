# collect-pc-info.ps1
#
# Собирает сведения об этом ПК (железо, ОС, сеть, установленное ПО) в JSON-файл
# для последующего импорта в NetworkMap — карточка "Импортировать файл" на вкладке
# "Устройства" (или "Импортировать папку" для пакетного импорта сразу нескольких файлов).
#
# Структура вывода и командлеты (Get-WmiObject) взяты из варианта, который реально
# проверен на Windows 11 — при необходимости замените на Get-CimInstance (современный
# аналог), если Get-WmiObject недоступен в вашей версии PowerShell.
#
# ВАЖНО: НЕ используется Win32_Product — этот класс WMI при опросе запускает
# самопроверку/переустановку каждого MSI-пакета и может занять десятки минут на
# обычном ПК. Список установленного ПО собирается быстрым способом — напрямую
# из реестра (ключи Uninstall), как это делает сама панель управления Windows.
#
# ИСПОЛЬЗОВАНИЕ:
#   powershell -ExecutionPolicy Bypass -File collect-pc-info.ps1
#   powershell -ExecutionPolicy Bypass -File collect-pc-info.ps1 -OutputPath "\\server\share\inventory"
#
# Удобнее запускать через collect-pc-info.bat (двойной клик, тот же -OutputPath первым
# аргументом) — см. рядом в этой же папке.
#
# Для настоящего удалённого запуска сразу на нескольких машинах (не обязательно,
# но пригодится, если ПК много):
#   Invoke-Command -ComputerName PC1,PC2,PC3 -FilePath .\collect-pc-info.ps1 `
#       -ArgumentList "\\server\share\inventory"
#   (нужны права администратора на удалённых машинах и включённый WinRM)
#
# Результат — файл <имя_компьютера>_<дата_время>.json в -OutputPath (по умолчанию —
# рядом со скриптом). Часть полей (серийный номер и т.п.) без прав администратора
# может не собраться — WMI в этом случае просто вернёт пустое значение, скрипт не упадёт.

param(
    [string]$OutputPath = (Get-Location).Path
)

# На случай завершающего "\" в пути (например, если запускается не через .bat,
# а передан путь вида "C:\shared\" напрямую) — убираем, иначе Join-Path ниже
# может дать двойной слеш, а сама передача такого пути в кавычках через cmd.exe
# способна исказить его на уровне разбора аргументов (см. collect-pc-info.bat)
$OutputPath = $OutputPath.TrimEnd('\', '/')

Write-Host "Собираю сведения о компьютере..." -ForegroundColor Cyan

# --- ОС и железо ---
$osInfo   = Get-WmiObject -Class Win32_OperatingSystem
$sysInfo  = Get-WmiObject -Class Win32_ComputerSystem
$biosInfo = Get-WmiObject -Class Win32_BIOS

# --- Сеть: собираем ВСЕ адаптеры с IP; при импорте программа сама выберет тот,
#     у которого есть шлюз по умолчанию (интернет-facing), как основной ---
$networkAdapters = @(Get-WmiObject -Class Win32_NetworkAdapterConfiguration -Filter "IPEnabled=True" | ForEach-Object {
    [PSCustomObject]@{
        Description = $_.Description
        IPAddress   = ($_.IPAddress | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1)
        MACAddress  = $_.MACAddress
        HasGateway  = [bool]$_.DefaultIPGateway
    }
})

# --- Установленное ПО: из реестра, не из Win32_Product (см. предупреждение вверху файла).
#     Проверяем и обычную ветку, и WOW6432Node (32-битные программы на 64-битной Windows).
#     SystemComponent исключает служебные компоненты Windows, которые не показываются
#     в обычном списке "Установленные программы". ---
$uninstallKeys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$software = @(
    $uninstallKeys |
    ForEach-Object { Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue } |
    Where-Object { $_.DisplayName -and $_.DisplayName.Trim() -ne '' -and -not $_.SystemComponent } |
    Select-Object @{n='Name';e={$_.DisplayName.Trim()}},
                  @{n='Version';e={$_.DisplayVersion}},
                  @{n='Publisher';e={$_.Publisher}} |
    Group-Object Name | ForEach-Object { $_.Group | Select-Object -First 1 } |
    Sort-Object Name
)

# --- Сборка результата ---
$systemInfo = [PSCustomObject]@{
    OperatingSystem = [PSCustomObject]@{
        Name         = $osInfo.Caption
        Version      = $osInfo.Version
        BuildNumber  = $osInfo.BuildNumber
        Architecture = $osInfo.OSArchitecture
    }
    Hardware = [PSCustomObject]@{
        System = [PSCustomObject]@{
            Manufacturer = $sysInfo.Manufacturer
            Model        = $sysInfo.Model
            RAM_GB       = [math]::Round($sysInfo.TotalPhysicalMemory / 1GB, 2)
            SerialNumber = $biosInfo.SerialNumber
        }
        Processor = @(Get-WmiObject -Class Win32_Processor | ForEach-Object {
            [PSCustomObject]@{
                Name              = $_.Name
                Cores             = $_.NumberOfCores
                LogicalProcessors = $_.NumberOfLogicalProcessors
            }
        })
        Disks = @(Get-WmiObject -Class Win32_DiskDrive | ForEach-Object {
            [PSCustomObject]@{
                Model     = $_.Model
                Size_GB   = [math]::Round($_.Size / 1GB, 2)
                Interface = $_.InterfaceType
            }
        })
    }
    Network  = $networkAdapters
    Software = $software
    Metadata = [PSCustomObject]@{
        ComputerName = $env:COMPUTERNAME
        Collected    = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    }
}

# --- Запись файла ---
if (-not (Test-Path $OutputPath)) {
    New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null
}
$fileName = "$($env:COMPUTERNAME)_$(Get-Date -Format 'yyyy-MM-dd_HHmmss').json"
$filePath = Join-Path $OutputPath $fileName

$systemInfo | ConvertTo-Json -Depth 5 | Out-File -FilePath $filePath -Encoding utf8

Write-Host "Готово: $filePath" -ForegroundColor Green
Write-Host "Найдено установленного ПО: $($software.Count)" -ForegroundColor Gray
