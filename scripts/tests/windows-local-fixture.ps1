Add-Type -AssemblyName System.Windows.Forms
$form=New-Object System.Windows.Forms.Form
$form.Text='YesImBot isolated acceptance'
$form.Width=520;$form.Height=240
$inputBox=New-Object System.Windows.Forms.TextBox
$inputBox.Left=20;$inputBox.Top=20;$inputBox.Width=450
$button=New-Object System.Windows.Forms.Button
$button.Text='Apply';$button.Left=20;$button.Top=65
$label=New-Object System.Windows.Forms.Label
$label.Left=20;$label.Top=110;$label.Width=450;$label.Text='Waiting'
$button.Add_Click({$label.Text=$inputBox.Text})
$form.Controls.AddRange(@($inputBox,$button,$label))
[void]$form.ShowDialog()
