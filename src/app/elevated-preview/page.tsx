"use client";

import {
  Heart,
  Sparkles,
  BookOpen,
  GraduationCap,
  Library,
  Brain,
  Lightbulb,
  Upload,
  FileText,
  Camera,
  ClipboardCheck,
  Type,
  ListOrdered,
  ArrowRight,
  Star,
} from "lucide-react";

export default function ElevatedPreview() {
  return (
    <div className="min-h-screen bg-[#f8f7ff] text-[#1e1b4b]">
      {/* Top notice */}
      <div className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-black/[0.06] px-4 py-3 flex items-center justify-between">
        <p className="text-[11px] font-black tracking-[0.14em] uppercase text-[#1e1b4b]/50">
          QUIZTIME · ELEVATED PREVIEW
        </p>
        <span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-[#1e1b4b] text-white tracking-wide">
          BEFORE → AFTER
        </span>
      </div>

      <div className="max-w-[520px] mx-auto px-4 py-6 pb-32 space-y-10">

        {/* Intro */}
        <div>
          <h1 className="text-[28px] font-[900] tracking-[-0.02em] leading-[1.1] m-0">
            Elevating beyond <span className="text-[#6366f1]">generic AI template</span>
          </h1>
          <p className="text-[14px] leading-[1.6] text-[#1e1b4b]/60 font-medium mt-3">
            Flat Digital Indigo matte, thicker icons in capsule borders, crisp inset shadows + subtle glow. 
            Developer credit moves to low-contrast footer.
          </p>
        </div>

        {/* 1. Header attribution */}
        <section>
          <h2 className="text-[13px] font-black tracking-widest uppercase text-[#1e1b4b]/40 mb-3 flex items-center gap-2">
            <span className="w-5 h-[2px] bg-[#1e1b4b]/20 rounded-full" /> 1 · Header Attribution
          </h2>
          
          <div className="grid gap-4">
            {/* BEFORE */}
            <div>
              <p className="text-[11px] font-bold text-red-500/70 uppercase tracking-wide mb-2">Before · attribution in header</p>
              <div className="rounded-[22px] bg-white border-[3px] border-white shadow-[0_10px_26px_rgba(43,80,180,0.16)] px-4 py-3 flex items-center gap-3">
                <img src="/images/logo.png" alt="" className="w-9 h-9 rounded-[10px] object-cover" />
                <div>
                  <p className="m-0 text-[15px] font-black">QuizTime</p>
                  <p className="m-0 text-[11px] text-[#5b7192]">Your AI Study Partner</p>
                  <p className="m-0 text-[10px] font-semibold text-[#5b7192] mt-[1px]">Developed by: FBC BSIT 3-A</p>
                </div>
              </div>
            </div>

            {/* AFTER */}
            <div>
              <p className="text-[11px] font-bold text-emerald-600 uppercase tracking-wide mb-2">After · clean header, credit in footer</p>
              <div className="rounded-[22px] bg-white/90 backdrop-blur-[14px] border border-white shadow-[0_8px_20px_rgba(0,0,0,0.06)] px-4 py-3 flex items-center gap-3">
                <img src="/images/logo.png" alt="" className="w-9 h-9 rounded-[10px] object-cover" />
                <div>
                  <p className="m-0 text-[15px] font-black tracking-tight">QuizTime</p>
                  <p className="m-0 text-[11px] text-[#1e1b4b]/50 font-semibold">Your AI Study Partner</p>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-[#1e1b4b] text-white flex items-center justify-center font-black text-[13px]">A</div>
                </div>
              </div>
              <p className="text-[10px] text-[#1e1b4b]/35 mt-2 text-center">
                Attribution removed from header — now lives in low-contrast footer only
              </p>
            </div>
          </div>
        </section>

        {/* 2. Main Card - Digital Indigo */}
        <section>
          <h2 className="text-[13px] font-black tracking-widest uppercase text-[#1e1b4b]/40 mb-3 flex items-center gap-2">
            <span className="w-5 h-[2px] bg-[#1e1b4b]/20 rounded-full" /> 2 · Main Card · Digital Indigo Matte
          </h2>

          <div className="grid gap-6">
            {/* BEFORE */}
            <div>
              <p className="text-[11px] font-bold text-red-500/70 uppercase tracking-wide mb-2">Before · muddy blue→purple gradient</p>
              <div
                className="relative overflow-hidden rounded-[28px] p-[28px_24px] text-white"
                style={{
                  background: "linear-gradient(165deg, #5b9cff 0%, #4f6df5 48%, #7c3aed 100%)",
                  border: "3px solid rgba(255,255,255,0.75)",
                  boxShadow: "inset 0 3px 8px rgba(255,255,255,0.35), inset 0 -10px 20px rgba(0,0,0,0.18), 0 18px 38px rgba(43,80,180,0.35)",
                }}
              >
                <div className="absolute -top-5 -right-5 w-[120px] h-[120px] bg-white/10 rounded-full" />
                <Heart size={48} strokeWidth={1.5} className="mb-3 animate-pulse" />
                <h3 className="m-0 text-[22px] font-black">QuizTime</h3>
                <p className="m-0 mt-1 text-[13px] opacity-90 leading-[1.5]">Upload your study material and I'll turn it into fun flashcards...</p>
                <button className="mt-5 inline-flex items-center gap-2 px-5 py-3 rounded-[18px] bg-white text-[#1d4ed8] font-extrabold text-[14px] shadow-[inset_0_2px_3px_rgba(255,255,255,1),inset_0_-4px_8px_rgba(43,80,180,0.12),0_5px_0_#1e3a8a,0_12px_24px_rgba(0,0,0,0.25)]">
                  <Sparkles size={18} /> Start Studying
                </button>
              </div>
            </div>

            {/* AFTER - ELEVATED */}
            <div>
              <p className="text-[11px] font-bold text-emerald-600 uppercase tracking-wide mb-2">After · bg-[#1e1b4b] matte + breathing room</p>
              
              {/* NEW PREMIUM CARD */}
              <div className="relative overflow-hidden rounded-[28px] p-[28px_24px] bg-[#1e1b4b] text-white border border-white/[0.08] shadow-[0_20px_40px_rgba(30,27,75,0.25),0_4px_12px_rgba(30,27,75,0.15)]">
                {/* Subtle inner highlight - not glossy, just depth */}
                <div className="absolute inset-0 rounded-[28px] pointer-events-none shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]" />
                
                {/* Icon with capsule border - thicker stroke 2.5 */}
                <div className="inline-flex items-center gap-2.5 px-3.5 py-2 rounded-full bg-white/[0.08] border border-white/[0.12] backdrop-blur-sm mb-4">
                  <div className="w-7 h-7 rounded-full bg-white/[0.10] border border-white/[0.14] flex items-center justify-center">
                    <Heart size={14} strokeWidth={2.5} className="text-white" />
                  </div>
                  <span className="text-[11px] font-bold tracking-wide text-white/70 uppercase">AI Study Partner</span>
                </div>

                <h3 className="m-0 text-[26px] font-[900] tracking-[-0.02em] leading-[1.1]">QuizTime</h3>
                <p className="m-0 mt-2.5 text-[14px] leading-[1.6] text-white/60 font-medium max-w-[32ch]">
                  Upload your study material and I&apos;ll turn it into fun flashcards — spaced repetition picks what to review.
                </p>

                {/* Feature icons with capsule borders */}
                <div className="mt-6 flex gap-2.5">
                  {[
                    { Icon: FileText, label: "PDF" },
                    { Icon: Brain, label: "Smart" },
                    { Icon: Library, label: "Sets" },
                  ].map(({ Icon, label }) => (
                    <div key={label} className="flex items-center gap-2 px-3 py-2 rounded-full bg-white/[0.06] border border-white/[0.10] backdrop-blur-sm">
                      <div className="w-6 h-6 rounded-full bg-white/[0.08] border border-white/[0.12] flex items-center justify-center">
                        <Icon size={12} strokeWidth={2.5} className="text-white/80" />
                      </div>
                      <span className="text-[11px] font-bold text-white/60">{label}</span>
                    </div>
                  ))}
                </div>

                {/* Elevated primary button - inset highlight + color-matched glow */}
                <button className="mt-7 inline-flex items-center gap-2.5 px-6 py-[14px] rounded-[16px] bg-white text-[#1e1b4b] font-[800] text-[14.5px] tracking-[-0.01em] 
                  shadow-[inset_0_1px_2px_rgba(255,255,255,0.4),0_4px_12px_rgba(255,255,255,0.12),0_8px_24px_rgba(99,102,241,0.25)]
                  hover:shadow-[inset_0_1px_2px_rgba(255,255,255,0.5),0_6px_16px_rgba(255,255,255,0.16),0_12px_32px_rgba(99,102,241,0.32)]
                  active:shadow-[inset_0_1px_1px_rgba(255,255,255,0.3),0_2px_8px_rgba(255,255,255,0.08)]
                  active:translate-y-[1px] transition-all duration-150"
                >
                  <Sparkles size={18} strokeWidth={2.5} />
                  Start Studying
                </button>

                {/* Secondary ghost on dark - also elevated */}
                <button className="mt-3 ml-3 inline-flex items-center gap-2 px-5 py-[13px] rounded-[16px] bg-white/[0.08] text-white/80 font-bold text-[13px] border border-white/[0.12] 
                  shadow-[inset_0_1px_2px_rgba(255,255,255,0.15),0_4px_12px_rgba(0,0,0,0.15)]
                  hover:bg-white/[0.12] hover:text-white transition-all"
                >
                  <Library size={16} strokeWidth={2.5} />
                  My Sets
                </button>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-[14px] bg-[#1e1b4b]/5 border border-[#1e1b4b]/10 px-3 py-2.5">
                  <p className="m-0 text-[11px] font-black uppercase tracking-wide text-[#1e1b4b]/40">Backdrop</p>
                  <p className="m-0 text-[12px] font-bold text-[#1e1b4b] mt-0.5">bg-[#1e1b4b] matte</p>
                  <p className="m-0 text-[10px] text-[#1e1b4b]/50 mt-1">No gradient · visual breathing room</p>
                </div>
                <div className="rounded-[14px] bg-[#1e1b4b]/5 border border-[#1e1b4b]/10 px-3 py-2.5">
                  <p className="m-0 text-[11px] font-black uppercase tracking-wide text-[#1e1b4b]/40">Feel</p>
                  <p className="m-0 text-[12px] font-bold text-[#1e1b4b] mt-0.5">Premium custom</p>
                  <p className="m-0 text-[10px] text-[#1e1b4b]/50 mt-1">Playful student aesthetic kept</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 3. Icons - Thicker stroke + capsule borders */}
        <section>
          <h2 className="text-[13px] font-black tracking-widest uppercase text-[#1e1b4b]/40 mb-3 flex items-center gap-2">
            <span className="w-5 h-[2px] bg-[#1e1b4b]/20 rounded-full" /> 3 · Icons · stroke 2.5 + capsule
          </h2>

          <div className="rounded-[20px] bg-white border-2 border-white shadow-[0_8px_24px_rgba(0,0,0,0.06)] p-5">
            <div className="grid grid-cols-2 gap-3">
              {[
                { Icon: BookOpen, label: "Study Mode", desc: "Flip to reveal" },
                { Icon: ClipboardCheck, label: "Exam Mode", desc: "4 choices" },
                { Icon: Type, label: "Identification", desc: "Type answer" },
                { Icon: ListOrdered, label: "Enumeration", desc: "List items" },
                { Icon: Brain, label: "Spaced Review", desc: "SM-2 schedule" },
                { Icon: GraduationCap, label: "Course Tailored", desc: "BS Pharmacy" },
              ].map(({ Icon, label, desc }) => (
                <div key={label} className="flex items-start gap-3 p-3 rounded-[16px] bg-[#f8f7ff] border border-[#1e1b4b]/[0.06]">
                  <div className="w-11 h-11 rounded-full bg-[#1e1b4b] text-white flex items-center justify-center border border-white/10 shadow-[inset_0_1px_2px_rgba(255,255,255,0.2),0_4px_12px_rgba(30,27,75,0.2)] shrink-0">
                    <Icon size={20} strokeWidth={2.5} />
                  </div>
                  <div className="min-w-0">
                    <p className="m-0 text-[13px] font-bold leading-tight">{label}</p>
                    <p className="m-0 text-[11px] text-[#1e1b4b]/50 font-medium mt-0.5">{desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-5 p-4 rounded-[16px] bg-[#1e1b4b] text-white">
              <p className="m-0 text-[11px] font-black uppercase tracking-wide text-white/40 mb-3">Capsule border variants · soft semi-transparent</p>
              <div className="flex flex-wrap gap-2.5">
                {[
                  { Icon: Heart, label: "Loved" },
                  { Icon: Sparkles, label: "AI Magic" },
                  { Icon: Library, label: "Library" },
                  { Icon: Upload, label: "Upload" },
                  { Icon: Camera, label: "Camera" },
                ].map(({ Icon, label }) => (
                  <div key={label} className="inline-flex items-center gap-2 px-3.5 py-2 rounded-full bg-white/[0.08] border border-white/[0.12] backdrop-blur-sm">
                    <div className="w-6 h-6 rounded-full bg-white/[0.10] border border-white/[0.14] flex items-center justify-center">
                      <Icon size={13} strokeWidth={2.5} className="text-white/90" />
                    </div>
                    <span className="text-[12px] font-bold text-white/70">{label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* 4. Buttons - inset + glow */}
        <section>
          <h2 className="text-[13px] font-black tracking-widest uppercase text-[#1e1b4b]/40 mb-3 flex items-center gap-2">
            <span className="w-5 h-[2px] bg-[#1e1b4b]/20 rounded-full" /> 4 · Buttons · inset + glow
          </h2>

          <div className="space-y-4">
            {/* Before */}
            <div className="rounded-[20px] bg-white border-2 border-white shadow-[0_8px_24px_rgba(0,0,0,0.06)] p-5">
              <p className="m-0 text-[11px] font-bold text-red-500/70 uppercase tracking-wide mb-3">Before · aggressive glossy drop shadows</p>
              <button className="w-full inline-flex items-center justify-center gap-2 px-6 py-4 rounded-[18px] bg-gradient-to-b from-[#5b9cff] to-[#2f6bee] text-white font-extrabold text-[15px] border border-white/35 shadow-[inset_0_2px_3px_rgba(255,255,255,0.45),inset_0_-4px_6px_rgba(0,0,0,0.18),0_5px_0_#1e40af,0_12px_24px_rgba(37,99,235,0.35)]">
                <Sparkles size={18} /> Generate Flashcards
              </button>
              <p className="m-0 mt-2 text-[10px] text-[#1e1b4b]/40 text-center font-medium">0 5px 0 #1e40af + 0 12px 24px glow · heavy toy key</p>
            </div>

            {/* After */}
            <div className="rounded-[20px] bg-[#1e1b4b] border border-white/10 shadow-[0_16px_32px_rgba(30,27,75,0.2)] p-5">
              <p className="m-0 text-[11px] font-bold text-emerald-300 uppercase tracking-wide mb-3">After · crisp inset + subtle color-matched glow</p>
              
              <div className="space-y-3">
                <button className="w-full inline-flex items-center justify-center gap-2.5 px-6 py-[15px] rounded-[16px] bg-white text-[#1e1b4b] font-[800] text-[15px] tracking-[-0.01em]
                  shadow-[inset_0_1px_2px_rgba(255,255,255,0.4),0_4px_12px_rgba(255,255,255,0.10),0_8px_24px_rgba(99,102,241,0.22)]
                  active:shadow-[inset_0_1px_1px_rgba(255,255,255,0.3),0_2px_6px_rgba(0,0,0,0.1)] active:translate-y-[1px] transition-all"
                >
                  <Sparkles size={18} strokeWidth={2.5} />
                  Generate Flashcards with AI
                </button>

                <div className="grid grid-cols-2 gap-3">
                  <button className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-[14px] bg-[#6366f1] text-white font-bold text-[13px]
                    shadow-[inset_0_1px_2px_rgba(255,255,255,0.4),0_4px_12px_rgba(99,102,241,0.35)] hover:shadow-[inset_0_1px_2px_rgba(255,255,255,0.5),0_6px_16px_rgba(99,102,241,0.45)] transition-all"
                  >
                    <BookOpen size={16} strokeWidth={2.5} /> Study
                  </button>
                  <button className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-[14px] bg-white/[0.08] text-white font-bold text-[13px] border border-white/[0.12]
                    shadow-[inset_0_1px_2px_rgba(255,255,255,0.15)] hover:bg-white/[0.12] transition-all"
                  >
                    <Library size={16} strokeWidth={2.5} /> Sets
                  </button>
                </div>

                <button className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-[14px] bg-transparent text-white/60 font-bold text-[13px] border border-white/[0.14]
                  shadow-[inset_0_1px_2px_rgba(255,255,255,0.08)] hover:text-white/90 hover:border-white/20 transition-all"
                >
                  <Star size={16} strokeWidth={2.5} /> Ghost · low emphasis
                </button>
              </div>

              <div className="mt-4 p-3 rounded-[12px] bg-white/[0.06] border border-white/[0.08]">
                <p className="m-0 font-mono text-[10px] leading-[1.5] text-white/50">
                  shadow: inset 0 1px 2px rgba(255,255,255,0.4) + 0 4px 12px color-glow<br/>
                  + 0 8px 24px rgba(99,102,241,0.22) · no heavy 5px drop
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* 5. Full Home mock with new design */}
        <section>
          <h2 className="text-[13px] font-black tracking-widest uppercase text-[#1e1b4b]/40 mb-3 flex items-center gap-2">
            <span className="w-5 h-[2px] bg-[#1e1b4b]/20 rounded-full" /> 5 · Full Preview · Elevated Home
          </h2>

          <div className="rounded-[28px] overflow-hidden bg-[#fafafb] border border-black/[0.06] shadow-[0_20px_60px_rgba(30,27,75,0.12)]">
            {/* Mock header */}
            <div className="px-4 py-3 flex items-center gap-3 bg-white border-b border-black/[0.04]">
              <img src="/images/logo.png" alt="" className="w-8 h-8 rounded-[9px] object-cover" />
              <div>
                <p className="m-0 text-[14px] font-black tracking-tight">QuizTime</p>
                <p className="m-0 text-[10px] text-[#1e1b4b]/50 font-semibold">Your AI Study Partner</p>
              </div>
              <div className="ml-auto w-7 h-7 rounded-full bg-[#1e1b4b] text-white flex items-center justify-center font-black text-[12px]">A</div>
            </div>

            {/* Mock hero - NEW */}
            <div className="p-4">
              <div className="rounded-[24px] p-[22px_20px] bg-[#1e1b4b] text-white relative overflow-hidden border border-white/[0.06] shadow-[0_16px_32px_rgba(30,27,75,0.2)]">
                <div className="absolute inset-0 rounded-[24px] pointer-events-none shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]" />
                
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.07] border border-white/[0.10] mb-3">
                  <div className="w-5 h-5 rounded-full bg-white/[0.10] border border-white/[0.12] flex items-center justify-center">
                    <Heart size={10} strokeWidth={2.5} />
                  </div>
                  <span className="text-[10px] font-bold tracking-wide text-white/60 uppercase">AI Study Partner</span>
                </div>

                <h3 className="m-0 text-[22px] font-black tracking-[-0.02em]">QuizTime</h3>
                <p className="m-0 mt-1.5 text-[13px] leading-[1.5] text-white/55 font-medium">
                  Upload PDFs or photos — I&apos;ll turn them into fun flashcards with spaced repetition.
                </p>

                <div className="mt-4 flex gap-2">
                  <button className="inline-flex items-center gap-2 px-4 py-2.5 rounded-[12px] bg-white text-[#1e1b4b] font-extrabold text-[13px] shadow-[inset_0_1px_2px_rgba(255,255,255,0.4),0_4px_10px_rgba(255,255,255,0.12)]">
                    <Sparkles size={14} strokeWidth={2.5} /> Start
                  </button>
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.06] border border-white/[0.08]">
                    <div className="w-5 h-5 rounded-full bg-white/[0.08] flex items-center justify-center"><Brain size={11} strokeWidth={2.5} /></div>
                    <span className="text-[10px] font-bold text-white/50">12 due</span>
                  </div>
                </div>
              </div>

              {/* Mock feature grid with new icon style */}
              <div className="mt-4 grid grid-cols-2 gap-2.5">
                {[
                  { Icon: FileText, title: "Upload PDF" },
                  { Icon: Camera, title: "Take Photo" },
                  { Icon: BookOpen, title: "Study Mode" },
                  { Icon: ClipboardCheck, title: "Exam Mode" },
                ].map(({ Icon, title }) => (
                  <div key={title} className="rounded-[16px] bg-white border border-black/[0.04] p-3 flex items-start gap-2.5 shadow-[0_2px_8px_rgba(0,0,0,0.03)]">
                    <div className="w-9 h-9 rounded-full bg-[#1e1b4b] text-white flex items-center justify-center border border-white/10 shadow-[inset_0_1px_1px_rgba(255,255,255,0.2)] shrink-0">
                      <Icon size={16} strokeWidth={2.5} />
                    </div>
                    <div>
                      <p className="m-0 text-[12px] font-bold">{title}</p>
                      <p className="m-0 text-[10px] text-[#1e1b4b]/45 font-medium mt-0.5">Tap to open</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Mock low-contrast footer */}
            <div className="px-4 py-3 bg-[#f6f5ff] border-t border-[#1e1b4b]/[0.06] flex items-center justify-center">
              <p className="m-0 text-[10px] font-medium tracking-wide text-[#1e1b4b]/30">
                Developed by <span className="font-bold text-[#1e1b4b]/40">FBC BSIT 3-A</span> · QuizTime © 2026
              </p>
            </div>
          </div>
        </section>

        {/* Implementation notes */}
        <section className="rounded-[20px] bg-[#1e1b4b] text-white p-5">
          <h3 className="m-0 text-[13px] font-black uppercase tracking-wide text-white/40 mb-3">Implementation Plan</h3>
          <div className="space-y-3 text-[12px] leading-[1.6] font-medium text-white/70">
            <p className="m-0"><span className="text-white font-bold">1. Header:</span> Remove <code className="px-1.5 py-0.5 rounded bg-white/10 text-white/90 text-[11px]">.app-developer</code> from .clay-topbar, keep logo + title + user only</p>
            <p className="m-0"><span className="text-white font-bold">2. Hero:</span> .clay-hero → bg-[#1e1b4b] solid matte, border-white/[0.08], shadow 0 20px 40px rgba(30,27,75,0.25), no gradient</p>
            <p className="m-0"><span className="text-white font-bold">3. Icons:</span> All Lucide inside hero get strokeWidth=2.5 + wrapper: rounded-full bg-white/[0.08] border border-white/[0.12]</p>
            <p className="m-0"><span className="text-white font-bold">4. Buttons:</span> .btn-primary new shadow: inset 0 1px 2px rgba(255,255,255,0.4) + 0 4px 12px glow + 0 8px 24px indigo glow</p>
            <p className="m-0"><span className="text-white font-bold">5. Footer:</span> New low-contrast footer: text-[#1e1b4b]/30, centered, 10px</p>
          </div>
          <div className="mt-4 flex gap-2">
            <a href="/" className="inline-flex items-center gap-2 px-4 py-2.5 rounded-[12px] bg-white text-[#1e1b4b] font-bold text-[12px] no-underline shadow-[inset_0_1px_2px_rgba(255,255,255,0.4)]">
              Back to App <ArrowRight size={14} strokeWidth={2.5} />
            </a>
            <span className="inline-flex items-center px-3 py-2 rounded-[12px] bg-white/10 text-white/60 font-bold text-[11px] border border-white/10">
              Preview only · production unchanged
            </span>
          </div>
        </section>

      </div>
    </div>
  );
}
