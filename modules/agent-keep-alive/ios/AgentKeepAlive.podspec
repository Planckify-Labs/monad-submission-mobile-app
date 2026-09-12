Pod::Spec.new do |s|
  s.name           = 'AgentKeepAlive'
  s.version        = '0.1.0'
  s.summary        = 'Keeps an in-flight Takumi Agent turn alive while backgrounded.'
  s.description    = 'Holds a finite iOS beginBackgroundTask assertion (and an Android foreground service via Kotlin) so an agent turn can finish when the app is sent to the background.'
  s.author         = 'TakumiPay'
  s.homepage       = 'https://takumipay.xyz'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
