param([string]$Prefix = "$HOME/.local/share/odinn")
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
& node "$Root/scripts/install.ts" install --source "$Root" --prefix "$Prefix" @args
exit $LASTEXITCODE
