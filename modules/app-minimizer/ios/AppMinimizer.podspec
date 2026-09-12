require 'json'

Pod::Spec.new do |s|
  s.name           = 'AppMinimizer'
  s.version        = '0.1.0'
  s.summary        = 'Sends the app task to the back after a deep-linked approval (Android); no-op on iOS.'
  s.description    = 'Local Expo module for TakumiPay.'
  s.author         = 'TakumiPay'
  s.homepage       = 'https://takumipay.xyz'
  s.license        = 'MIT'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
