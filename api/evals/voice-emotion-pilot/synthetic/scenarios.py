# Synthetic voice-emotion scenarios: scripted lines acted in a known emotion
# (ground truth = the acted tone). No member or team voice.
TONES = ["calm", "happy", "sad", "angry", "anxious"]
import os
ROUND = os.environ.get("ROUND", "1")
TAG1 = {"calm": "[calm]", "happy": "[excited]", "sad": "[sad]", "angry": "[angry]", "anxious": "[nervous]"}
TAG2 = {"calm": "[calm]", "happy": "[excited] [laughs]", "sad": "[sad] [sighs]", "angry": "[angry] [shouting]", "anxious": "[nervous] [stammers]"}
TAG = TAG2 if ROUND == "2" else TAG1
VOICES = {"roger": "CwhRBWXzGAHq8TQ4Fs17", "sarah": "EXAVITQu4vr4xnSDxMaL", "chris": "iP95p4xoKVk53GoZ742B", "jessica": "cgSgspJ2msm6clMCkdW9"}
CONTEXT = "Co: Hey, how's everything going this week?"

# Calm, factual words: the words alone don't carry the feeling.
MASKED_SHORT = ["Yeah, I'm fine.", "Sounds good.", "It's okay, it worked out.", "Sure, that works for me.", "I guess that's fine."]
MASKED_LONG = [
    "So this week I mostly worked on the pitch deck, met with two investors on Tuesday, and on Thursday I had a call with our designer about the new landing page. That's pretty much it.",
    "I moved into the new apartment last weekend. It's in the Mission, about twenty minutes from the office. I'm still unpacking boxes, and I haven't really met anyone in the building yet.",
    "We had the team meeting this morning. We went over the launch timeline, pushed the release to next month, and I'm taking over the onboarding flow from Sam.",
    "My sister is coming to visit this weekend. She's flying in Friday night, and I think we're doing dinner Saturday and maybe a hike on Sunday if the weather holds.",
    "I talked to my manager about the promotion today. She said they're still deciding, and I should hear back by the end of the month.",
]
# Words that say the feeling, acted the same way.
CONGRUENT = {
    "happy": "I got the offer! Honestly I can't believe it, I've been waiting on this for months and they said yes. I called my mom right away, I'm still kind of shaking.",
    "sad": "It's been a hard week. My grandma passed on Sunday and I haven't really been sleeping. I keep going to text her and then remembering.",
    "angry": "I'm so done with this. My cofounder pushed the release again without telling me, and I found out from a customer. This is the third time.",
    "anxious": "I have the investor meeting tomorrow and I can't stop running through it. What if they ask about churn? I don't think the numbers are good enough.",
    "calm": "It was a good, quiet weekend. I read a bit, cooked dinner, went for a walk by the water. Nothing big, just a reset.",
}
# Cheerful words, unhappy delivery.
INCONGRUENT = [("No, it's great, really. Everything's great.", "sad"), ("Oh perfect. That's just perfect.", "angry")]

def tagged(text, tone, long):
    t = TAG[tone]
    if not long: return f"{t} {text}"
    parts = text.split(". ", 1)
    return f"{t} {parts[0]}. {t} {parts[1]}" if len(parts) == 2 else f"{t} {text}"

def scenarios():
    out = []
    for vi, (vname, vid) in enumerate(VOICES.items()):
        for ti, tone in enumerate(TONES):
            s = MASKED_SHORT[(vi + ti) % 5]
            out.append(dict(id=f"{vname}_maskedshort_{tone}", voice=vname, voice_id=vid, kind="masked_short", tone=tone, text=s, say=tagged(s, tone, False)))
            l = MASKED_LONG[(vi + ti) % 5]
            out.append(dict(id=f"{vname}_maskedlong_{tone}", voice=vname, voice_id=vid, kind="masked_long", tone=tone, text=l, say=tagged(l, tone, True)))
            c = CONGRUENT[tone]
            out.append(dict(id=f"{vname}_congruent_{tone}", voice=vname, voice_id=vid, kind="congruent", tone=tone, text=c, say=tagged(c, tone, True)))
        for i, (txt, tone) in enumerate(INCONGRUENT):
            out.append(dict(id=f"{vname}_incongruent{i}_{tone}", voice=vname, voice_id=vid, kind="incongruent", tone=tone, text=txt, say=tagged(txt, tone, False)))
    return out
