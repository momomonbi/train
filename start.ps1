$trainDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $trainDir 'server.mjs')
