Pod::Spec.new do |s|
  s.name         = 'LibDFBridge'
  s.version      = '0.1.0'
  s.summary      = 'Native libDF bridge for Coherent'
  s.description  = 'Bridges the official DeepFilterNet libDF runtime into the iOS app.'
  s.homepage     = 'https://github.com/Rikorose/DeepFilterNet'
  s.license      = { :type => 'MIT' }
  s.author       = { 'Coherent' => 'local' }
  s.platforms    = { :ios => '17.0' }
  s.source       = { :path => '.' }
  s.prepare_command = 'bash scripts/build_libdf_ios.sh'

  s.source_files = ['ios/LibDFBridge.{h,m}', 'ios/include/**/*.h']
  s.public_header_files = ['ios/LibDFBridge.h', 'ios/include/**/*.h']
  s.header_mappings_dir = 'ios/include'
  s.preserve_paths = ['ios/LibDF.xcframework', 'ios/include/deep_filter.h', 'scripts/build_libdf_ios.sh']
  s.vendored_frameworks = 'ios/LibDF.xcframework'
  s.pod_target_xcconfig = {
    'HEADER_SEARCH_PATHS' => '"${PODS_TARGET_SRCROOT}/ios/include"'
  }

  s.dependency 'React-Core'
end
