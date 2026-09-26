"""Soundtrack for the sync-worktrees brag: A minor, 120 BPM, 22 s, cuts on beats.

Music and effects are written as one piece: effects use notes from the key and sit under the music.
"""
import wave

import numpy as np

SR = 48000
DUR = 22.0
N = int(SR * DUR)
BEAT = 0.5
rng = np.random.default_rng(7)


def t_axis(n):
    return np.arange(n) / SR


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def place(buf, sig, at, gain=1.0):
    i = int(at * SR)
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[: j - i] * gain


def spectral(x, fn):
    """Filter by multiplying the spectrum with fn(freqs)."""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(X * fn(f), len(x))


def lowpass(x, fc, order=2):
    return spectral(x, lambda f: 1 / np.sqrt(1 + (f / fc) ** (2 * order)))


def highpass(x, fc, order=2):
    return spectral(x, lambda f: 1 / np.sqrt(1 + (fc / np.maximum(f, 1e-3)) ** (2 * order)))


def bandpass(x, lo, hi):
    return highpass(lowpass(x, hi), lo)


def env_ad(n, a, d):
    t = t_axis(n)
    e = np.minimum(1, t / max(a, 1e-4)) * np.exp(-np.maximum(0, t - a) / d)
    return e


# --- harmony: bars of 2 s: Am F C G (x3, the last bar lands on Am) ---
CHORDS = [
    [57, 60, 64, 71],  # Am(add9-ish voicing: A C E B)
    [53, 57, 60, 67],  # Fmaj(add9: F A C G)
    [48, 55, 60, 64],  # C (C G C E)
    [55, 59, 62, 69],  # G(add9: G B D A)
]
ROOTS = [45, 41, 48, 43]  # A2 F2 C3 G2


def chord_at(bar):
    return CHORDS[bar % 4], ROOTS[bar % 4]


def saw_voice(freq, n, detune=0.0):
    t = t_axis(n)
    out = np.zeros(n)
    for k in range(1, 12):
        out += np.sin(2 * np.pi * freq * k * (1 + detune) * t + k) / k
    return out


# --- pad ---
pad = np.zeros(N)
for bar in range(11):
    notes, _ = chord_at(bar)
    n = int(2.3 * SR)
    seg = np.zeros(n)
    for m in notes:
        f = midi(m)
        seg += saw_voice(f, n, 0.0) + saw_voice(f, n, 0.004) * 0.8
    t = t_axis(n)
    e = np.minimum(1, t / 0.35) * np.where(t > 2.0, np.exp(-(t - 2.0) / 0.12), 1)
    place(pad, seg * e, bar * 2.0)
# darker in the hook, opening up at the drop
pad_dark = lowpass(pad, 700)
pad_open = lowpass(pad, 2600)
tt = t_axis(N)
mix_k = np.clip((tt - 3.0) / 0.6, 0, 1)
pad = pad_dark * (1 - mix_k) + pad_open * mix_k
pad *= 0.05

# --- drums (from the drop at 3.5 s; they stop at 20.5 s) ---
kick = np.zeros(N)
kick_env = np.zeros(N)  # for sidechain ducking
kn = int(0.32 * SR)
kt = t_axis(kn)
freq = 45 + 70 * np.exp(-kt / 0.03)
k_sig = np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-kt / 0.13)
k_sig += 0.3 * np.sin(2 * np.pi * np.cumsum(freq) / SR * 2) * np.exp(-kt / 0.02)
beats = np.arange(3.5, 20.5, BEAT)
for b in beats:
    place(kick, k_sig, b, 0.55)
    place(kick_env, np.exp(-kt / 0.12), b)

hat = np.zeros(N)
hn = int(0.05 * SR)
h_sig = highpass(rng.standard_normal(hn), 7000) * np.exp(-t_axis(hn) / 0.012)
for b in beats:
    place(hat, h_sig, b + 0.25, 0.08 if b >= 7.0 else 0.05)

clap = np.zeros(N)
cn = int(0.22 * SR)
c_noise = bandpass(rng.standard_normal(cn), 900, 5000)
c_env = np.exp(-t_axis(cn) / 0.07)
c_sig = c_noise * c_env
for b in np.arange(7.5, 20.5, 1.0):  # beats 2 and 4
    place(clap, c_sig, b, 0.07)

# --- bass: 8ths on the root from the drop ---
bass = np.zeros(N)
bn = int(0.24 * SR)
bt = t_axis(bn)
for k, b in enumerate(np.arange(3.5, 20.5, 0.25)):
    bar = int(b // 2)
    _, root = chord_at(bar)
    f = midi(root)
    s = np.sin(2 * np.pi * f * bt) + 0.35 * np.sin(2 * np.pi * 2 * f * bt)
    s = np.tanh(1.6 * s) * env_ad(bn, 0.005, 0.12)
    place(bass, s, b, 0.16 if k % 2 == 0 else 0.1)

# --- pluck arpeggio from the folders scene on ---
pluck = np.zeros(N)
pn = int(0.4 * SR)
pt = t_axis(pn)
pattern = [0, 2, 1, 3, 2, 1, 3, 2]
for k, b in enumerate(np.arange(7.0, 20.5, 0.25)):
    bar = int(b // 2)
    notes, _ = chord_at(bar)
    m = notes[pattern[k % len(pattern)]] + 12
    f = midi(m)
    s = (np.sin(2 * np.pi * f * pt) + 0.25 * np.sin(2 * np.pi * 2 * f * pt)) * env_ad(pn, 0.003, 0.09)
    place(pluck, s, b, 0.05 if k % 2 == 0 else 0.035)
pluck = lowpass(pluck, 3500)

# --- effects ---
fx = np.zeros(N)

# key clicks while the two commands type
click_n = int(0.012 * SR)
click = bandpass(rng.standard_normal(click_n), 1800, 5200) * np.exp(-t_axis(click_n) / 0.003)
for i in range(39):
    place(fx, click, 0.15 + i * (0.95 / 39), 0.05 + 0.02 * rng.random())
for i in range(16):
    place(fx, click, 1.65 + i * (0.4 / 16), 0.05 + 0.02 * rng.random())

# strike-through swish (1.3 s)
sw_n = int(0.3 * SR)
sw = rng.standard_normal(sw_n)
sw_t = t_axis(sw_n)
sw = bandpass(sw, 600, 3000) * np.sin(np.pi * sw_t / 0.3) ** 2
place(fx, sw, 1.28, 0.06)

# `cd` lands: a soft two-note chime, A5 then E6
bell_n = int(1.2 * SR)
bt2 = t_axis(bell_n)


def bell(f):
    return (np.sin(2 * np.pi * f * bt2) + 0.3 * np.sin(2 * np.pi * f * 2.76 * bt2) * np.exp(-bt2 / 0.15)) * env_ad(bell_n, 0.004, 0.45)


place(fx, bell(midi(81)), 2.08, 0.07)
place(fx, bell(midi(88)), 2.16, 0.06)

# riser into the drop (2.4 -> 3.5)
r_n = int(1.1 * SR)
r_t = t_axis(r_n)
riser = np.zeros(r_n)
noise = rng.standard_normal(r_n)
blocks = 22
for i in range(blocks):
    a, b = i * r_n // blocks, (i + 1) * r_n // blocks
    fc = 400 + (6000 - 400) * (i / blocks) ** 2
    seg = lowpass(noise, fc)[a:b]
    riser[a:b] = seg
riser *= (r_t / 1.1) ** 2
place(fx, riser, 2.4, 0.05)

# whooshes into each cut
wh_n = int(0.5 * SR)
wh_t = t_axis(wh_n)
wh = np.zeros(wh_n)
noise = rng.standard_normal(wh_n)
for i in range(10):
    a, b = i * wh_n // 10, (i + 1) * wh_n // 10
    fc = 3500 - 2800 * (i / 10)
    wh[a:b] = bandpass(noise, fc * 0.4, fc)[a:b]
wh *= np.sin(np.pi * wh_t / 0.5) ** 2
for cut in [7.0, 11.0, 14.5, 18.5]:
    place(fx, wh, cut - 0.25, 0.045)

# folders appear: soft pentatonic pops, rising
penta = [69, 72, 74, 76, 79, 81, 84, 86, 88, 91]
pop_n = int(0.25 * SR)
pop_t = t_axis(pop_n)
for i, m in enumerate(penta):
    s = np.sin(2 * np.pi * midi(m) * pop_t) * env_ad(pop_n, 0.002, 0.06)
    place(fx, s, 7.7 + i * 0.11, 0.035)

# outro: a sustained Am(add9) hit with a long tail
hit_n = int(3.5 * SR)
ht = t_axis(hit_n)
hit = np.zeros(hit_n)
for m in [45, 57, 64, 71, 72]:
    hit += np.sin(2 * np.pi * midi(m) * ht) * np.exp(-ht / 1.4)
hit += lowpass(rng.standard_normal(hit_n), 5000) * np.exp(-ht / 0.25) * 0.4
place(fx, hit, 18.5, 0.06)

# --- mix ---
duck = 1 - 0.35 * np.clip(kick_env, 0, 1)
music = pad * duck + bass * duck + pluck * duck + kick + hat + clap
mix = music + fx
# gentle master: soft clip, fades, normalise to -1 dBFS
mix = np.tanh(mix * 1.4) / 1.4
fade_in = np.clip(tt / 0.02, 0, 1)
fade_out = np.clip((DUR - tt) / 1.3, 0, 1) ** 1.5
mix *= fade_in * fade_out
mix *= 10 ** (-1 / 20) / np.max(np.abs(mix))

# slight stereo width: pad/pluck spread, everything else centred
side = (lowpass(pluck, 3500) * 0.3 + pad * 0.15)
side = np.roll(side, int(0.012 * SR)) - side
left = mix + side * 0.5
right = mix - side * 0.5
peak = max(np.max(np.abs(left)), np.max(np.abs(right)))
left, right = left / peak * 0.89, right / peak * 0.89

pcm = (np.stack([left, right], axis=1) * 32767).astype(np.int16)
with wave.open("soundtrack.wav", "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print("soundtrack.wav", DUR, "s")
