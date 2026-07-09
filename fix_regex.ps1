file = 'e:\ai-js\index.js'
content = [System.IO.File]::ReadAllText(file, [System.Text.Encoding]::UTF8)
old = '/<tool_call/i.test(rawHTML2)'
new = '/<tool_call/i.test(rawHTML2)'
content = content.Replace(content.Replace(content.Replace(old, new)
[System.IO.File]::WriteAllText(file, $content, [System.Text.Encoding]::UTF8)
Write-Host 'Fixed'
