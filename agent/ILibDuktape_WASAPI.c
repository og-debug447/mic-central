/* Native Windows Core Audio capture for MeshAgent. */
#include "ILibDuktape_WASAPI.h"
#include "ILibDuktape_Helpers.h"
#include "ILibDuktapeModSearch.h"

#ifdef WIN32
#define COBJMACROS
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <avrt.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propvarutil.h>
#include <ksmedia.h>
#include <stdint.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "uuid.lib")
#pragma comment(lib, "propsys.lib")
#pragma comment(lib, "avrt.lib")

#define WASAPI_CAPTURE_PTR "\xFF_wasapi_capture"
#define WASAPI_RING_FRAMES 4800
#define WASAPI_MAX_READ_FRAMES 4800

/* C Core Audio headers declare these GUIDs but do not provide definitions in uuid.lib. */
static const CLSID MCAUDIO_CLSID_MMDeviceEnumerator = { 0xBCDE0395, 0xE52F, 0x467C, { 0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E } };
static const IID MCAUDIO_IID_IMMDeviceEnumerator = { 0xA95664D2, 0x9614, 0x4F35, { 0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6 } };
static const IID MCAUDIO_IID_IAudioClient = { 0x1CB9AD4C, 0xDBFA, 0x4C32, { 0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2 } };
static const IID MCAUDIO_IID_IAudioCaptureClient = { 0xC8ADBD64, 0xE71E, 0x48A0, { 0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17 } };
static const GUID MCAUDIO_SUBTYPE_IEEE_FLOAT = { 0x00000003, 0x0000, 0x0010, { 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71 } };

typedef enum WasapiState
{
    WASAPI_STATE_STOPPED = 0,
    WASAPI_STATE_STARTING = 1,
    WASAPI_STATE_RUNNING = 2,
    WASAPI_STATE_DEVICE_LOST = 3,
    WASAPI_STATE_RECONNECTED = 4,
    WASAPI_STATE_ERROR = 5
} WasapiState;

typedef struct WasapiCapture
{
    HANDLE thread;
    HANDLE stopEvent;
    CRITICAL_SECTION lock;
    wchar_t *deviceId;
    int loopback;
    volatile LONG state;
    int started;
    int readFrame;
    int writeFrame;
    int frameCount;
    int16_t ring[WASAPI_RING_FRAMES][2];
} WasapiCapture;

static void Wasapi_SetState(WasapiCapture *capture, WasapiState state)
{
    InterlockedExchange(&capture->state, (LONG)state);
}

static const char *Wasapi_StateString(LONG state)
{
    switch ((WasapiState)state)
    {
        case WASAPI_STATE_STARTING: return "starting";
        case WASAPI_STATE_RUNNING: return "running";
        case WASAPI_STATE_DEVICE_LOST: return "device-lost";
        case WASAPI_STATE_RECONNECTED: return "reconnected";
        case WASAPI_STATE_ERROR: return "error";
        default: return "stopped";
    }
}

static wchar_t *Wasapi_Utf8ToWide(const char *value, int length)
{
    int count;
    wchar_t *ret;
    if (value == NULL || length < 1 || length > 4096) return NULL;
    count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, length, NULL, 0);
    if (count <= 0) return NULL;
    ret = (wchar_t*)malloc(sizeof(wchar_t) * (count + 1));
    if (ret == NULL) return NULL;
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, length, ret, count) != count) { free(ret); return NULL; }
    ret[count] = 0;
    return ret;
}

static void Wasapi_PushWide(duk_context *ctx, const wchar_t *value)
{
    int count = WideCharToMultiByte(CP_UTF8, 0, value, -1, NULL, 0, NULL, NULL);
    char *utf8;
    if (count <= 0) { duk_push_string(ctx, ""); return; }
    utf8 = (char*)malloc((size_t)count);
    if (utf8 == NULL) { duk_push_string(ctx, ""); return; }
    if (WideCharToMultiByte(CP_UTF8, 0, value, -1, utf8, count, NULL, NULL) != count) { free(utf8); duk_push_string(ctx, ""); return; }
    duk_push_lstring(ctx, utf8, (duk_size_t)(count - 1));
    free(utf8);
}

static HRESULT Wasapi_InitializeCom(BOOL *uninitialize)
{
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    *uninitialize = SUCCEEDED(hr);
    if (hr == RPC_E_CHANGED_MODE) return S_OK;
    return hr;
}

static duk_ret_t Wasapi_Enumerate(duk_context *ctx)
{
    const char *kind;
    EDataFlow flow;
    BOOL uninitialize = FALSE;
    HRESULT hr;
    IMMDeviceEnumerator *enumerator = NULL;
    IMMDeviceCollection *collection = NULL;
    UINT count = 0, i, outCount = 0;

    if (!duk_is_string(ctx, 0)) return ILibDuktape_Error(ctx, "wasapi.enumerate(kind) requires a source kind");
    kind = duk_get_string(ctx, 0);
    if (strcmp(kind, "microphone") == 0) flow = eCapture;
    else if (strcmp(kind, "loopback") == 0) flow = eRender;
    else return ILibDuktape_Error(ctx, "Audio source kind must be microphone or loopback");

    hr = Wasapi_InitializeCom(&uninitialize);
    if (FAILED(hr)) return ILibDuktape_Error(ctx, "Could not initialize Windows audio services");
    hr = CoCreateInstance(&MCAUDIO_CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, &MCAUDIO_IID_IMMDeviceEnumerator, (void**)&enumerator);
    if (SUCCEEDED(hr)) hr = IMMDeviceEnumerator_EnumAudioEndpoints(enumerator, flow, DEVICE_STATE_ACTIVE, &collection);
    if (SUCCEEDED(hr)) hr = IMMDeviceCollection_GetCount(collection, &count);
    if (FAILED(hr))
    {
        if (collection) IMMDeviceCollection_Release(collection);
        if (enumerator) IMMDeviceEnumerator_Release(enumerator);
        if (uninitialize) CoUninitialize();
        return ILibDuktape_Error(ctx, "Could not enumerate Windows audio endpoints");
    }

    duk_push_array(ctx);
    for (i = 0; i < count; ++i)
    {
        IMMDevice *device = NULL;
        IPropertyStore *store = NULL;
        LPWSTR id = NULL;
        PROPVARIANT name;
        PropVariantInit(&name);
        if (SUCCEEDED(IMMDeviceCollection_Item(collection, i, &device)) &&
            SUCCEEDED(IMMDevice_GetId(device, &id)) &&
            SUCCEEDED(IMMDevice_OpenPropertyStore(device, STGM_READ, &store)) &&
            SUCCEEDED(IPropertyStore_GetValue(store, &PKEY_Device_FriendlyName, &name)) && name.vt == VT_LPWSTR)
        {
            duk_push_object(ctx);
            Wasapi_PushWide(ctx, id);
            duk_put_prop_string(ctx, -2, "id");
            Wasapi_PushWide(ctx, name.pwszVal);
            duk_put_prop_string(ctx, -2, "name");
            duk_put_prop_index(ctx, -2, outCount++);
        }
        PropVariantClear(&name);
        if (id) CoTaskMemFree(id);
        if (store) IPropertyStore_Release(store);
        if (device) IMMDevice_Release(device);
    }
    IMMDeviceCollection_Release(collection);
    IMMDeviceEnumerator_Release(enumerator);
    if (uninitialize) CoUninitialize();
    return 1;
}

static float Wasapi_ReadSample(const BYTE *frame, const WAVEFORMATEX *format, UINT channel)
{
    UINT bits = format->wBitsPerSample;
    const BYTE *p = frame + (channel * bits / 8);
    BOOL isFloat = (format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT);
    int validBits = (int)bits;
    if (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE)
    {
        const WAVEFORMATEXTENSIBLE *ext = (const WAVEFORMATEXTENSIBLE*)format;
        isFloat = IsEqualGUID(&ext->SubFormat, &MCAUDIO_SUBTYPE_IEEE_FLOAT);
        if (ext->Samples.wValidBitsPerSample != 0) validBits = ext->Samples.wValidBitsPerSample;
    }
    if (isFloat && bits == 32)
    {
        float f;
        memcpy(&f, p, sizeof(float));
        return (f < -1.0f) ? -1.0f : ((f > 1.0f) ? 1.0f : f);
    }
    if (bits == 8) return ((float)p[0] - 128.0f) / 128.0f;
    if (bits == 16)
    {
        int16_t v; memcpy(&v, p, sizeof(v));
        if (validBits < 16) v = (int16_t)(v >> (16 - validBits));
        return (float)v / (float)(1 << (validBits - 1));
    }
    if (bits == 24)
    {
        int32_t v = (int32_t)p[0] | ((int32_t)p[1] << 8) | ((int32_t)p[2] << 16);
        if ((v & 0x800000) != 0) v |= (int32_t)0xFF000000;
        if (validBits < 24) v >>= (24 - validBits);
        return (float)v / (float)(1u << (validBits - 1));
    }
    if (bits == 32)
    {
        int32_t v; memcpy(&v, p, sizeof(v));
        if (validBits < 32) v >>= (32 - validBits);
        return (float)((double)v / (double)(1ULL << (validBits - 1)));
    }
    return 0.0f;
}

static void Wasapi_ConvertFrame(const BYTE *frame, const WAVEFORMATEX *format, float *left, float *right)
{
    UINT channels = format->nChannels;
    float l = 0.0f, r = 0.0f, lWeight = 0.0f, rWeight = 0.0f;
    if (channels == 1) { l = r = Wasapi_ReadSample(frame, format, 0); }
    else if (channels >= 2)
    {
        DWORD mask = 0;
        if (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE)
        {
            mask = ((const WAVEFORMATEXTENSIBLE*)format)->dwChannelMask;
        }
        if (mask != 0)
        {
            const DWORD speakers[] = {
                SPEAKER_FRONT_LEFT, SPEAKER_FRONT_RIGHT, SPEAKER_FRONT_CENTER, SPEAKER_LOW_FREQUENCY,
                SPEAKER_BACK_LEFT, SPEAKER_BACK_RIGHT, SPEAKER_FRONT_LEFT_OF_CENTER, SPEAKER_FRONT_RIGHT_OF_CENTER,
                SPEAKER_BACK_CENTER, SPEAKER_SIDE_LEFT, SPEAKER_SIDE_RIGHT
            };
            UINT index = 0, speakerIndex;
            for (speakerIndex = 0; speakerIndex < (UINT)(sizeof(speakers) / sizeof(speakers[0])) && index < channels; ++speakerIndex)
            {
                if ((mask & speakers[speakerIndex]) == 0) continue;
                {
                    float v = Wasapi_ReadSample(frame, format, index++);
                    switch (speakers[speakerIndex])
                    {
                        case SPEAKER_FRONT_LEFT: case SPEAKER_FRONT_LEFT_OF_CENTER: case SPEAKER_BACK_LEFT: case SPEAKER_SIDE_LEFT:
                            l += v * ((speakers[speakerIndex] == SPEAKER_FRONT_LEFT) ? 1.0f : 0.70710678f); lWeight += ((speakers[speakerIndex] == SPEAKER_FRONT_LEFT) ? 1.0f : 0.70710678f); break;
                        case SPEAKER_FRONT_RIGHT: case SPEAKER_FRONT_RIGHT_OF_CENTER: case SPEAKER_BACK_RIGHT: case SPEAKER_SIDE_RIGHT:
                            r += v * ((speakers[speakerIndex] == SPEAKER_FRONT_RIGHT) ? 1.0f : 0.70710678f); rWeight += ((speakers[speakerIndex] == SPEAKER_FRONT_RIGHT) ? 1.0f : 0.70710678f); break;
                        case SPEAKER_FRONT_CENTER: case SPEAKER_BACK_CENTER:
                            l += v * 0.5f; r += v * 0.5f; lWeight += 0.5f; rWeight += 0.5f; break;
                        default: break; /* Exclude LFE from the speech/music mix. */
                    }
                }
            }
            if (index != channels) { l = Wasapi_ReadSample(frame, format, 0); r = Wasapi_ReadSample(frame, format, 1); }
            else { if (lWeight > 1.0f) l /= lWeight; if (rWeight > 1.0f) r /= rWeight; }
        }
        else { l = Wasapi_ReadSample(frame, format, 0); r = Wasapi_ReadSample(frame, format, 1); }
    }
    *left = (l < -1.0f) ? -1.0f : ((l > 1.0f) ? 1.0f : l);
    *right = (r < -1.0f) ? -1.0f : ((r > 1.0f) ? 1.0f : r);
}

static int16_t Wasapi_ToPcm(float value)
{
    long v = (long)(value * 32767.0f);
    if (v < -32768) v = -32768;
    if (v > 32767) v = 32767;
    return (int16_t)v;
}

static void Wasapi_PushFrame(WasapiCapture *capture, int16_t left, int16_t right)
{
    EnterCriticalSection(&capture->lock);
    if (capture->frameCount == WASAPI_RING_FRAMES)
    {
        capture->readFrame = (capture->readFrame + 1) % WASAPI_RING_FRAMES;
        --capture->frameCount;
    }
    capture->ring[capture->writeFrame][0] = left;
    capture->ring[capture->writeFrame][1] = right;
    capture->writeFrame = (capture->writeFrame + 1) % WASAPI_RING_FRAMES;
    ++capture->frameCount;
    LeaveCriticalSection(&capture->lock);
}

static void Wasapi_ClearRing(WasapiCapture *capture)
{
    EnterCriticalSection(&capture->lock);
    capture->readFrame = capture->writeFrame;
    capture->frameCount = 0;
    LeaveCriticalSection(&capture->lock);
}

static HRESULT Wasapi_CaptureOnce(WasapiCapture *capture, BOOL reconnected)
{
    HRESULT hr;
    BOOL uninitialize = FALSE;
    IMMDeviceEnumerator *enumerator = NULL;
    IMMDevice *device = NULL;
    IAudioClient *audioClient = NULL;
    IAudioCaptureClient *captureClient = NULL;
    WAVEFORMATEX *mixFormat = NULL;
    WAVEFORMATEX desiredFormat;
    WAVEFORMATEX *closestFormat = NULL;
    const WAVEFORMATEX *format = NULL;
    HANDLE audioEvent = NULL;
    DWORD flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
    UINT32 packetFrames;
    BOOL hasPrevious = FALSE;
    float previousLeft = 0.0f, previousRight = 0.0f;
    double nextPosition = 0.0, sourceStep = 1.0;

    hr = Wasapi_InitializeCom(&uninitialize);
    if (FAILED(hr)) return hr;
    hr = CoCreateInstance(&MCAUDIO_CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, &MCAUDIO_IID_IMMDeviceEnumerator, (void**)&enumerator);
    if (SUCCEEDED(hr)) hr = IMMDeviceEnumerator_GetDevice(enumerator, capture->deviceId, &device);
    if (SUCCEEDED(hr)) hr = IMMDevice_Activate(device, &MCAUDIO_IID_IAudioClient, CLSCTX_ALL, NULL, (void**)&audioClient);
    if (SUCCEEDED(hr)) hr = IAudioClient_GetMixFormat(audioClient, &mixFormat);
    if (FAILED(hr)) goto cleanup;

    ZeroMemory(&desiredFormat, sizeof(desiredFormat));
    desiredFormat.wFormatTag = WAVE_FORMAT_PCM;
    desiredFormat.nChannels = 2;
    desiredFormat.nSamplesPerSec = 48000;
    desiredFormat.wBitsPerSample = 16;
    desiredFormat.nBlockAlign = 4;
    desiredFormat.nAvgBytesPerSec = 192000;
    hr = IAudioClient_IsFormatSupported(audioClient, AUDCLNT_SHAREMODE_SHARED, &desiredFormat, &closestFormat);
    if (hr == S_OK) format = &desiredFormat;
    else if (capture->loopback) format = mixFormat;
    else
    {
        /* Let the Windows audio engine perform mic format conversion when
         * the endpoint's native mix format is not 48 kHz stereo PCM. */
        format = &desiredFormat;
        flags |= AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    }
    if (closestFormat) { CoTaskMemFree(closestFormat); closestFormat = NULL; }

    if (capture->loopback) flags = AUDCLNT_STREAMFLAGS_LOOPBACK;
    hr = IAudioClient_Initialize(audioClient, AUDCLNT_SHAREMODE_SHARED, flags, 0, 0, (WAVEFORMATEX*)format, NULL);
    if (FAILED(hr) && !capture->loopback && format == &desiredFormat)
    {
        /* A few drivers reject the engine resampler flags. Keep microphone
         * capture available through the native mix format as a fallback. */
        if (audioEvent) { CloseHandle(audioEvent); audioEvent = NULL; }
        IAudioClient_Release(audioClient);
        audioClient = NULL;
        hr = IMMDevice_Activate(device, &MCAUDIO_IID_IAudioClient, CLSCTX_ALL, NULL, (void**)&audioClient);
        if (SUCCEEDED(hr))
        {
            format = mixFormat;
            flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
            hr = IAudioClient_Initialize(audioClient, AUDCLNT_SHAREMODE_SHARED, flags, 0, 0, (WAVEFORMATEX*)format, NULL);
        }
    }
    if (FAILED(hr)) goto cleanup;
    if (!capture->loopback)
    {
        audioEvent = CreateEventW(NULL, FALSE, FALSE, NULL);
        if (audioEvent == NULL) { hr = HRESULT_FROM_WIN32(GetLastError()); goto cleanup; }
        hr = IAudioClient_SetEventHandle(audioClient, audioEvent);
    }
    if (SUCCEEDED(hr)) hr = IAudioClient_GetService(audioClient, &MCAUDIO_IID_IAudioCaptureClient, (void**)&captureClient);
    if (FAILED(hr)) goto cleanup;
    sourceStep = (double)format->nSamplesPerSec / 48000.0;
    hr = IAudioClient_Start(audioClient);
    if (FAILED(hr)) goto cleanup;
    Wasapi_SetState(capture, reconnected ? WASAPI_STATE_RECONNECTED : WASAPI_STATE_RUNNING);

    while (WaitForSingleObject(capture->stopEvent, 0) != WAIT_OBJECT_0)
    {
        DWORD waitResult;
        if (capture->loopback)
        {
            /* Poll loopback at 10 ms so it also works on Windows builds without loopback event signaling. */
            waitResult = WaitForSingleObject(capture->stopEvent, 10);
            if (waitResult == WAIT_OBJECT_0) { hr = S_OK; break; }
            if (waitResult != WAIT_TIMEOUT) { hr = HRESULT_FROM_WIN32(GetLastError()); break; }
        }
        else
        {
            HANDLE waits[2] = { capture->stopEvent, audioEvent };
            waitResult = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
            if (waitResult == WAIT_OBJECT_0) { hr = S_OK; break; }
            if (waitResult != WAIT_OBJECT_0 + 1) { hr = HRESULT_FROM_WIN32(GetLastError()); break; }
        }
        hr = IAudioCaptureClient_GetNextPacketSize(captureClient, &packetFrames);
        if (FAILED(hr)) break;
        while (packetFrames != 0)
        {
            BYTE *data = NULL;
            UINT32 frames = 0;
            DWORD bufferFlags = 0;
            UINT32 i;
            hr = IAudioCaptureClient_GetBuffer(captureClient, &data, &frames, &bufferFlags, NULL, NULL);
            if (FAILED(hr)) break;
            for (i = 0; i < frames; ++i)
            {
                float left, right;
                if ((bufferFlags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) { left = right = 0.0f; }
                else Wasapi_ConvertFrame(data + (i * format->nBlockAlign), format, &left, &right);
                if (!hasPrevious)
                {
                    Wasapi_PushFrame(capture, Wasapi_ToPcm(left), Wasapi_ToPcm(right));
                    previousLeft = left; previousRight = right; hasPrevious = TRUE; nextPosition = sourceStep;
                }
                else
                {
                    while (nextPosition <= 1.0)
                    {
                        float outLeft = previousLeft + (left - previousLeft) * (float)nextPosition;
                        float outRight = previousRight + (right - previousRight) * (float)nextPosition;
                        Wasapi_PushFrame(capture, Wasapi_ToPcm(outLeft), Wasapi_ToPcm(outRight));
                        nextPosition += sourceStep;
                    }
                    nextPosition -= 1.0;
                    previousLeft = left; previousRight = right;
                }
            }
            IAudioCaptureClient_ReleaseBuffer(captureClient, frames);
            if (FAILED(hr)) break;
            hr = IAudioCaptureClient_GetNextPacketSize(captureClient, &packetFrames);
            if (FAILED(hr)) break;
        }
        if (FAILED(hr)) break;
    }
    IAudioClient_Stop(audioClient);

cleanup:
    if (captureClient) IAudioCaptureClient_Release(captureClient);
    if (audioClient) IAudioClient_Release(audioClient);
    if (device) IMMDevice_Release(device);
    if (enumerator) IMMDeviceEnumerator_Release(enumerator);
    if (mixFormat) CoTaskMemFree(mixFormat);
    if (closestFormat) CoTaskMemFree(closestFormat);
    if (audioEvent) CloseHandle(audioEvent);
    if (uninitialize) CoUninitialize();
    return hr;
}

static DWORD WINAPI Wasapi_CaptureThread(LPVOID arg)
{
    WasapiCapture *capture = (WasapiCapture*)arg;
    BOOL reconnected = FALSE;
    DWORD taskIndex = 0;
    HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
    if (mmcss == NULL) mmcss = AvSetMmThreadCharacteristicsW(L"Audio", &taskIndex);
    for (;;)
    {
        HRESULT hr = Wasapi_CaptureOnce(capture, reconnected);
        if (WaitForSingleObject(capture->stopEvent, 0) == WAIT_OBJECT_0) break;
        if (hr == AUDCLNT_E_DEVICE_INVALIDATED || hr == HRESULT_FROM_WIN32(ERROR_NOT_FOUND))
        {
            Wasapi_ClearRing(capture);
            Wasapi_SetState(capture, WASAPI_STATE_DEVICE_LOST);
            if (WaitForSingleObject(capture->stopEvent, 1000) == WAIT_OBJECT_0) break;
            reconnected = TRUE;
            continue;
        }
        Wasapi_SetState(capture, WASAPI_STATE_ERROR);
        break;
    }
    if (mmcss != NULL) AvRevertMmThreadCharacteristics(mmcss);
    if (WaitForSingleObject(capture->stopEvent, 0) == WAIT_OBJECT_0) Wasapi_SetState(capture, WASAPI_STATE_STOPPED);
    return 0;
}

static WasapiCapture *Wasapi_GetCapture(duk_context *ctx, duk_idx_t index)
{
    return (WasapiCapture*)Duktape_GetPointerProperty(ctx, index, WASAPI_CAPTURE_PTR);
}

/* MeshAgent instance methods receive their object through JavaScript `this`,
 * which must be pushed onto the Duktape stack explicitly. */
static WasapiCapture *Wasapi_GetThisCapture(duk_context *ctx)
{
    WasapiCapture *capture;
    duk_push_this(ctx);
    capture = Wasapi_GetCapture(ctx, -1);
    duk_pop(ctx);
    return capture;
}

static duk_ret_t Wasapi_CaptureStart(duk_context *ctx)
{
    WasapiCapture *capture = Wasapi_GetThisCapture(ctx);
    if (capture == NULL) return ILibDuktape_Error(ctx, "Audio capture is closed");
    if (capture->thread != NULL) { duk_push_true(ctx); return 1; }
    ResetEvent(capture->stopEvent);
    Wasapi_SetState(capture, WASAPI_STATE_STARTING);
    capture->thread = CreateThread(NULL, 0, Wasapi_CaptureThread, capture, 0, NULL);
    if (capture->thread == NULL) { Wasapi_SetState(capture, WASAPI_STATE_ERROR); return ILibDuktape_Error(ctx, "Could not start WASAPI capture thread"); }
    capture->started = 1;
    duk_push_true(ctx);
    return 1;
}

static duk_ret_t Wasapi_CaptureStop(duk_context *ctx)
{
    WasapiCapture *capture = Wasapi_GetThisCapture(ctx);
    if (capture == NULL) { duk_push_false(ctx); return 1; }
    SetEvent(capture->stopEvent);
    if (capture->thread != NULL)
    {
        WaitForSingleObject(capture->thread, INFINITE);
        CloseHandle(capture->thread);
        capture->thread = NULL;
    }
    Wasapi_SetState(capture, WASAPI_STATE_STOPPED);
    duk_push_true(ctx);
    return 1;
}

static duk_ret_t Wasapi_CaptureState(duk_context *ctx)
{
    WasapiCapture *capture = Wasapi_GetThisCapture(ctx);
    if (capture == NULL) duk_push_string(ctx, "error");
    else duk_push_string(ctx, Wasapi_StateString(InterlockedCompareExchange(&capture->state, 0, 0)));
    return 1;
}

static duk_ret_t Wasapi_CaptureRead(duk_context *ctx)
{
    WasapiCapture *capture = Wasapi_GetThisCapture(ctx);
    int maxFrames = duk_get_int_default(ctx, 0, 480);
    int frames, i;
    duk_size_t size;
    void *buffer;
    if (capture == NULL) return ILibDuktape_Error(ctx, "Audio capture is closed");
    if (maxFrames < 1) maxFrames = 1;
    if (maxFrames > WASAPI_MAX_READ_FRAMES) maxFrames = WASAPI_MAX_READ_FRAMES;
    EnterCriticalSection(&capture->lock);
    frames = capture->frameCount < maxFrames ? capture->frameCount : maxFrames;
    size = (duk_size_t)(frames * 4);
    duk_push_buffer_raw(ctx, size, DUK_BUF_FLAG_DYNAMIC);
    buffer = duk_get_buffer_data(ctx, -1, NULL);
    for (i = 0; i < frames; ++i)
    {
        memcpy((BYTE*)buffer + (i * 4), capture->ring[capture->readFrame], 4);
        capture->readFrame = (capture->readFrame + 1) % WASAPI_RING_FRAMES;
    }
    capture->frameCount -= frames;
    LeaveCriticalSection(&capture->lock);
    duk_push_buffer_object(ctx, -1, 0, size, DUK_BUFOBJ_NODEJS_BUFFER);
    duk_remove(ctx, -2);
    return 1;
}

static duk_ret_t Wasapi_CaptureFinalizer(duk_context *ctx)
{
    WasapiCapture *capture = Wasapi_GetCapture(ctx, 0);
    if (capture != NULL)
    {
        SetEvent(capture->stopEvent);
        if (capture->thread != NULL) { WaitForSingleObject(capture->thread, INFINITE); CloseHandle(capture->thread); }
        CloseHandle(capture->stopEvent);
        DeleteCriticalSection(&capture->lock);
        free(capture->deviceId);
        duk_push_pointer(ctx, NULL);
        duk_put_prop_string(ctx, 0, WASAPI_CAPTURE_PTR);
        free(capture);
    }
    return 0;
}

static duk_ret_t Wasapi_CreateCapture(duk_context *ctx)
{
    const char *kind, *id;
    duk_size_t idLength;
    WasapiCapture *capture;
    if (!duk_is_string(ctx, 0) || !duk_is_string(ctx, 1)) return ILibDuktape_Error(ctx, "wasapi.createCapture(kind, deviceId) requires strings");
    kind = duk_get_string(ctx, 0);
    id = duk_get_lstring(ctx, 1, &idLength);
    if (strcmp(kind, "microphone") != 0 && strcmp(kind, "loopback") != 0) return ILibDuktape_Error(ctx, "Audio source kind must be microphone or loopback");
    if (idLength < 1 || idLength > 1024) return ILibDuktape_Error(ctx, "Audio device ID length is invalid");
    capture = (WasapiCapture*)calloc(1, sizeof(WasapiCapture));
    if (capture == NULL) return ILibDuktape_Error(ctx, "Out of memory");
    capture->deviceId = Wasapi_Utf8ToWide(id, (int)idLength);
    capture->loopback = strcmp(kind, "loopback") == 0;
    capture->stopEvent = CreateEventW(NULL, TRUE, TRUE, NULL);
    if (capture->deviceId == NULL || capture->stopEvent == NULL)
    {
        if (capture->stopEvent) CloseHandle(capture->stopEvent);
        free(capture->deviceId); free(capture);
        return ILibDuktape_Error(ctx, "Could not allocate WASAPI capture state");
    }
    InitializeCriticalSection(&capture->lock);
    capture->state = WASAPI_STATE_STOPPED;
    duk_push_object(ctx);
    duk_push_pointer(ctx, capture);
    duk_put_prop_string(ctx, -2, WASAPI_CAPTURE_PTR);
    ILibDuktape_CreateInstanceMethod(ctx, "start", Wasapi_CaptureStart, 0);
    ILibDuktape_CreateInstanceMethod(ctx, "stop", Wasapi_CaptureStop, 0);
    ILibDuktape_CreateInstanceMethod(ctx, "getState", Wasapi_CaptureState, 0);
    ILibDuktape_CreateInstanceMethod(ctx, "read", Wasapi_CaptureRead, DUK_VARARGS);
    ILibDuktape_CreateFinalizer(ctx, Wasapi_CaptureFinalizer);
    return 1;
}

static void Wasapi_Push(duk_context *ctx, void *chain)
{
    (void)chain;
    duk_push_object(ctx);
    duk_push_c_function(ctx, Wasapi_Enumerate, 1);
    duk_put_prop_string(ctx, -2, "enumerate");
    duk_push_c_function(ctx, Wasapi_CreateCapture, 2);
    duk_put_prop_string(ctx, -2, "createCapture");
}

void ILibDuktape_WASAPI_Init(duk_context *ctx)
{
    ILibDuktape_ModSearch_AddHandler(ctx, "wasapi", Wasapi_Push);
}

#else
static duk_ret_t Wasapi_Unsupported(duk_context *ctx)
{
    return ILibDuktape_Error(ctx, "WASAPI is only available on Windows");
}
static void Wasapi_Push(duk_context *ctx, void *chain)
{
    (void)chain;
    duk_push_object(ctx);
    duk_push_c_function(ctx, Wasapi_Unsupported, DUK_VARARGS);
    duk_put_prop_string(ctx, -2, "enumerate");
    duk_push_c_function(ctx, Wasapi_Unsupported, DUK_VARARGS);
    duk_put_prop_string(ctx, -2, "createCapture");
}
void ILibDuktape_WASAPI_Init(duk_context *ctx)
{
    ILibDuktape_ModSearch_AddHandler(ctx, "wasapi", Wasapi_Push);
}
#endif

