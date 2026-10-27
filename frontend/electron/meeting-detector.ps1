# Read only the call controls of the installed Teams/Webex clients, without
# activating windows, clicking controls or reading meeting contents.
param([switch]$Once)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Normalize-ControlName([string]$Value) {
    return ([regex]::Replace($Value.Normalize([Text.NormalizationForm]::FormD), '\p{Mn}', '')).ToLowerInvariant()
}

function Get-MeetingCalls {
    $clients = @{}
    foreach ($process in Get-Process) {
        if ($process.ProcessName -match '^(ms-teams|msteams|teams)$') { $clients[$process.Id] = 'teams' }
        elseif ($process.ProcessName -match '^(webex|webexhost|ciscocollabhost|atmgr|ptoneclk|wmlhost)$') { $clients[$process.Id] = 'webex' }
    }
    if ($clients.Count -eq 0) { return }
    $found = @{}
    $buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button)
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($window in $windows) {
        try {
            $client = $clients[$window.Current.ProcessId]
            if (!$client -or $found.ContainsKey($client)) { continue }
            $buttons = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
            $hasLeave = $false; $hasAudio = $false; $hasHangupId = $false
            foreach ($button in $buttons) {
                $properties = $button.Current
                if (!$properties.IsEnabled) { continue }
                $name = Normalize-ControlName $properties.Name
                $controlId = $properties.AutomationId
                if ($controlId -match '(?i)^(hangup-button|call-hangup|hangup|leave-meeting-button)$') { $hasHangupId = $true }
                if ($name -match '^(leave( (the )?(meeting|call))?|sair( (da|de|desta) (reuniao|chamada))?|hang up|desligar( chamada)?|end (meeting|call)|terminar (reuniao|chamada)|encerrar (reuniao|chamada))($|\s*[\(,])') { $hasLeave = $true }
                if ($name -match '(mute|unmute|microphone|microfone|silenciar|reativar.*audio|ativar.*som|desativar.*som)' -or $controlId -match '(?i)(microphone|microfone|mute)') { $hasAudio = $true }
            }
            # Pre-join screens have microphone controls but no leave/hang-up control.
            if ($hasHangupId -or ($hasLeave -and $hasAudio)) {
                $found[$client] = @{ id = $client; name = $(if ($client -eq 'teams') { 'Microsoft Teams' } else { 'Webex' }) }
            }
        } catch [System.Windows.Automation.ElementNotAvailableException] {
            # A closing window is normal; the next observation confirms absence.
            continue
        }
    }
    foreach ($call in $found.Values) { $call }
}

do {
    try {
        $calls = @(Get-MeetingCalls)
        @{ calls = $calls; error = '' } | ConvertTo-Json -Compress -Depth 3
    } catch {
        @{ calls = @(); error = 'UI Automation unavailable' } | ConvertTo-Json -Compress
    }
    if (!$Once) { Start-Sleep -Seconds 4 }
} while (!$Once)
