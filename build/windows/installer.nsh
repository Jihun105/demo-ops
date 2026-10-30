; 저장 중인 앱을 설치/제거 프로그램이 종료하지 않습니다.
; nsProcess 603은 찾는 프로세스가 없음을 뜻하며 다른 오류에서는 중단합니다.
!macro customCheckAppRunning
  demoCheckRunning:
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    StrCmp $R0 603 demoNotRunning
    StrCmp $R0 0 demoRunning
    MessageBox MB_OK|MB_ICONSTOP "프로그램 실행 상태를 확인하지 못했습니다. 관리자에게 문의해주세요." /SD IDOK
    Quit
  demoRunning:
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "데모 업무관리에서 저장을 마치고 프로그램을 정상 종료한 뒤 다시 시도해주세요." /SD IDCANCEL IDRETRY demoCheckRunning
    Quit
  demoNotRunning:
!macroend
