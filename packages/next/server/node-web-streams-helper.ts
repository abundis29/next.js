export function readableStreamTee<T = any>(
  readable: ReadableStream<T>
): [ReadableStream<T>, ReadableStream<T>] {
  const transformStream = new TransformStream()
  const transformStream2 = new TransformStream()
  const writer = transformStream.writable.getWriter()
  const writer2 = transformStream2.writable.getWriter()

  const reader = readable.getReader()
  function read() {
    reader.read().then(({ done, value }) => {
      if (done) {
        writer.close()
        writer2.close()
        return
      }
      writer.write(value)
      writer2.write(value)
      read()
    })
  }
  read()

  return [transformStream.readable, transformStream2.readable]
}

export function pipeTo<T>(
  readable: ReadableStream<T>,
  writable: WritableStream<T>,
  options?: { preventClose: boolean }
) {
  let resolver: () => void
  const promise = new Promise<void>((resolve) => (resolver = resolve))

  const reader = readable.getReader()
  const writer = writable.getWriter()
  function process() {
    reader.read().then(({ done, value }) => {
      if (done) {
        if (options?.preventClose) {
          writer.releaseLock()
        } else {
          writer.close()
        }
        resolver()
      } else {
        writer.write(value)
        process()
      }
    })
  }
  process()
  return promise
}

export function pipeThrough<Input, Output>(
  readable: ReadableStream<Input>,
  transformStream: TransformStream<Input, Output>
) {
  pipeTo(readable, transformStream.writable)
  return transformStream.readable
}

export function chainStreams<T>(
  streams: ReadableStream<T>[]
): ReadableStream<T> {
  const { readable, writable } = new TransformStream()

  let promise = Promise.resolve()
  for (let i = 0; i < streams.length; ++i) {
    promise = promise.then(() =>
      pipeTo(streams[i], writable, {
        preventClose: i + 1 < streams.length,
      })
    )
  }

  return readable
}

export function streamFromArray(strings: string[]): ReadableStream<Uint8Array> {
  // Note: we use a TransformStream here instead of instantiating a ReadableStream
  // because the built-in ReadableStream polyfill runs strings through TextEncoder.
  const { readable, writable } = new TransformStream()

  const writer = writable.getWriter()
  strings.forEach((str) => writer.write(encodeText(str)))
  writer.close()

  return readable
}

export async function streamToString(
  stream: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = stream.getReader()
  let bufferedString = ''

  while (true) {
    const { done, value } = await reader.read()

    if (done) {
      return bufferedString
    }

    bufferedString += decodeText(value)
  }
}

export function encodeText(input: string) {
  return new TextEncoder().encode(input)
}

export function decodeText(input?: Uint8Array) {
  return new TextDecoder().decode(input)
}

export function createTransformStream<Input, Output>({
  flush,
  transform,
}: {
  flush?: (
    controller: TransformStreamDefaultController<Output>
  ) => Promise<void> | void
  transform?: (
    chunk: Input,
    controller: TransformStreamDefaultController<Output>
  ) => Promise<void> | void
}): TransformStream<Input, Output> {
  const source = new TransformStream()
  const sink = new TransformStream()
  const reader = source.readable.getReader()
  const writer = sink.writable.getWriter()

  const controller = {
    enqueue(chunk: Output) {
      writer.write(chunk)
    },

    error(reason: Error) {
      writer.abort(reason)
      reader.cancel()
    },

    terminate() {
      writer.close()
      reader.cancel()
    },

    get desiredSize() {
      return writer.desiredSize
    },
  }

  ;(async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          const maybePromise = flush?.(controller)
          if (maybePromise) {
            await maybePromise
          }
          writer.close()
          return
        }

        if (transform) {
          const maybePromise = transform(value, controller)
          if (maybePromise) {
            await maybePromise
          }
        } else {
          controller.enqueue(value)
        }
      }
    } catch (err) {
      writer.abort(err)
    }
  })()

  return {
    readable: sink.readable,
    writable: source.writable,
  }
}

export function createBufferedTransformStream(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  let bufferedString = ''
  let pendingFlush: Promise<void> | null = null

  const flushBuffer = (controller: TransformStreamDefaultController) => {
    if (!pendingFlush) {
      pendingFlush = new Promise((resolve) => {
        setTimeout(() => {
          controller.enqueue(encodeText(bufferedString))
          bufferedString = ''
          pendingFlush = null
          resolve()
        }, 0)
      })
    }
    return pendingFlush
  }

  return createTransformStream({
    transform(chunk, controller) {
      bufferedString += decodeText(chunk)
      flushBuffer(controller)
    },

    flush() {
      if (pendingFlush) {
        return pendingFlush
      }
    },
  })
}

export function createFlushEffectStream(
  handleFlushEffect: () => Promise<string>
): TransformStream<Uint8Array, Uint8Array> {
  return createTransformStream({
    async transform(chunk, controller) {
      const extraChunk = await handleFlushEffect()
      // those should flush together at once
      controller.enqueue(encodeText(extraChunk + decodeText(chunk)))
    },
  })
}

export async function renderToStream({
  ReactDOMServer,
  element,
  suffix,
  dataStream,
  generateStaticHTML,
  flushEffectHandler,
}: {
  ReactDOMServer: typeof import('react-dom/server')
  element: React.ReactElement
  suffix?: string
  dataStream?: ReadableStream<Uint8Array>
  generateStaticHTML: boolean
  flushEffectHandler?: () => Promise<string>
}): Promise<ReadableStream<Uint8Array>> {
  const closeTag = '</body></html>'
  const suffixUnclosed = suffix ? suffix.split(closeTag)[0] : null
  const renderStream: ReadableStream<Uint8Array> & {
    allReady?: Promise<void>
  } = await (ReactDOMServer as any).renderToReadableStream(element)

  if (generateStaticHTML) {
    await renderStream.allReady
  }

  const transforms: Array<TransformStream<Uint8Array, Uint8Array>> = [
    createBufferedTransformStream(),
    flushEffectHandler ? createFlushEffectStream(flushEffectHandler) : null,
    suffixUnclosed != null ? createPrefixStream(suffixUnclosed) : null,
    dataStream ? createInlineDataStream(dataStream) : null,
    suffixUnclosed != null ? createSuffixStream(closeTag) : null,
  ].filter(Boolean) as any

  return transforms.reduce(
    (readable, transform) => pipeThrough(readable, transform),
    renderStream
  )
}

export function createSuffixStream(
  suffix: string
): TransformStream<Uint8Array, Uint8Array> {
  return createTransformStream({
    flush(controller) {
      if (suffix) {
        controller.enqueue(encodeText(suffix))
      }
    },
  })
}

export function createPrefixStream(
  prefix: string
): TransformStream<Uint8Array, Uint8Array> {
  let prefixFlushed = false
  let prefixPrefixFlushFinished: Promise<void> | null = null
  return createTransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      if (!prefixFlushed && prefix) {
        prefixFlushed = true
        prefixPrefixFlushFinished = new Promise((res) => {
          // NOTE: streaming flush
          // Enqueue prefix part before the major chunks are enqueued so that
          // prefix won't be flushed too early to interrupt the data stream
          setTimeout(() => {
            controller.enqueue(encodeText(prefix))
            res()
          })
        })
      }
    },
    flush(controller) {
      if (prefixPrefixFlushFinished) return prefixPrefixFlushFinished
      if (!prefixFlushed && prefix) {
        prefixFlushed = true
        controller.enqueue(encodeText(prefix))
      }
    },
  })
}

export function createInlineDataStream(
  dataStream: ReadableStream<Uint8Array>
): TransformStream<Uint8Array, Uint8Array> {
  let dataStreamFinished: Promise<void> | null = null
  return createTransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk)

      if (!dataStreamFinished) {
        const dataStreamReader = dataStream.getReader()

        // NOTE: streaming flush
        // We are buffering here for the inlined data stream because the
        // "shell" stream might be chunkenized again by the underlying stream
        // implementation, e.g. with a specific high-water mark. To ensure it's
        // the safe timing to pipe the data stream, this extra tick is
        // necessary.
        dataStreamFinished = new Promise((res) =>
          setTimeout(async () => {
            try {
              while (true) {
                const { done, value } = await dataStreamReader.read()
                if (done) {
                  return res()
                }
                controller.enqueue(value)
              }
            } catch (err) {
              controller.error(err)
            }
            res()
          }, 0)
        )
      }
    },
    flush() {
      if (dataStreamFinished) {
        return dataStreamFinished
      }
    },
  })
}
