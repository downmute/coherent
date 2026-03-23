#import "LibDFBridge.h"

#import "deep_filter.h"

@interface LibDFBridge ()
@property (nonatomic, assign) DFState *state;
@property (nonatomic, assign) NSUInteger frameLength;
@property (nonatomic, strong) dispatch_queue_t queue;
@end

@implementation LibDFBridge

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  self = [super init];
  if (self) {
    _state = NULL;
    _frameLength = 0;
    _queue = dispatch_queue_create("com.coherent.libdf", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (dispatch_queue_t)methodQueue
{
  return self.queue;
}

- (void)invalidateState
{
  if (self.state != NULL) {
    df_free(self.state);
    self.state = NULL;
    self.frameLength = 0;
  }
}

RCT_REMAP_METHOD(initialize,
                 initializeWithModelDir:(NSString *)modelDir
                 attenLim:(nonnull NSNumber *)attenLim
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  [self invalidateState];

  if (modelDir.length == 0) {
    reject(@"libdf_init", @"Model directory is empty.", nil);
    return;
  }

  const char *path = modelDir.fileSystemRepresentation;
  DFState *created = df_create(path, attenLim.floatValue, NULL);
  if (created == NULL) {
    reject(@"libdf_init", @"Failed to initialize libDF.", nil);
    return;
  }

  self.state = created;
  self.frameLength = df_get_frame_length(created);
  resolve(@{ @"frameLength": @(self.frameLength) });
}

RCT_EXPORT_METHOD(reset)
{
  if (self.state != NULL) {
    df_reset(self.state);
  }
}

RCT_EXPORT_METHOD(dispose)
{
  [self invalidateState];
}

RCT_REMAP_METHOD(processFrame,
                 processFrameSamples:(NSArray<NSNumber *> *)samples
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  if (self.state == NULL) {
    reject(@"libdf_process", @"libDF is not initialized.", nil);
    return;
  }
  if (samples.count != self.frameLength) {
    NSString *message = [NSString stringWithFormat:@"Expected %lu samples, got %lu.",
                         (unsigned long)self.frameLength,
                         (unsigned long)samples.count];
    reject(@"libdf_process", message, nil);
    return;
  }

  float *input = (float *)calloc(self.frameLength, sizeof(float));
  float *output = (float *)calloc(self.frameLength, sizeof(float));
  if (input == NULL || output == NULL) {
    free(input);
    free(output);
    reject(@"libdf_process", @"Failed to allocate audio buffers.", nil);
    return;
  }

  for (NSUInteger i = 0; i < self.frameLength; i++) {
    input[i] = samples[i].floatValue;
  }

  CFAbsoluteTime start = CFAbsoluteTimeGetCurrent();
  float lsnr = df_process_frame(self.state, input, output);
  CFTimeInterval processMs = (CFAbsoluteTimeGetCurrent() - start) * 1000.0;

  NSMutableArray<NSNumber *> *result = [NSMutableArray arrayWithCapacity:self.frameLength];
  for (NSUInteger i = 0; i < self.frameLength; i++) {
    [result addObject:@(output[i])];
  }

  free(input);
  free(output);

  resolve(@{
    @"output": result,
    @"lsnr": @(lsnr),
    @"processMs": @(processMs),
  });
}

@end
