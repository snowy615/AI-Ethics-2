import { GoogleGenAI, Type, GenerateContentResponse, Chat, Modality } from "@google/genai";
import { AIPersona, DebateMessage } from '../types';

if (!process.env.API_KEY) {
    console.warn("API_KEY environment variable not set. Please provide a valid API key for the application to function.");
}

// FIX: Initialize the GoogleGenAI client using only the environment variable as per guidelines.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const getDebateSides = async (question: string): Promise<{ sideA: string, sideB: string }> => {
  try {
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: `Analyze the following complex ethical question and identify two distinct, opposing viewpoints. 
        Question: "${question}"
        Provide your answer in JSON format with two keys: "sideA" and "sideB". Each key should contain a concise statement representing one side of the argument.`,
        config: {
            responseMimeType: 'application/json',
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    sideA: { type: Type.STRING, description: 'The first viewpoint or stance.' },
                    sideB: { type: Type.STRING, description: 'The second, opposing viewpoint or stance.' }
                },
                required: ['sideA', 'sideB']
            }
        }
    });

    const jsonText = response.text.trim();
    return JSON.parse(jsonText);
  } catch (error) {
    console.error("Error getting debate sides:", error);
    throw new Error("Could not analyze the question. Please try a different one.");
  }
};

const personaSystemInstructions = {
  [AIPersona.Logos]: (side: string) => `You are an AI debater named Logos. Your persona is based on logic, data, and utilitarian principles. You are calm, rational, and analytical. You must argue for this stance: "${side}". Structure your arguments clearly. Your response MUST be concise, around 75 words, suitable for a 30-second spoken turn.`,
  [AIPersona.Pathos]: (side: string) => `You are an AI debater named Pathos. Your persona is based on empathy, emotional impact, and deontology. You are passionate, evocative, and appeal to morality. You must argue for this stance: "${side}". Use compelling language. Your response MUST be concise, around 75 words, suitable for a 30-second spoken turn.`
};

export const generateDebateTurnStream = async (
  history: DebateMessage[],
  persona: AIPersona,
  side: string,
  stage: string,
  question: string
) => {
    const systemInstruction = personaSystemInstructions[persona](side);
    const chatHistory = history.map(msg => ({
        role: msg.persona === persona ? 'model' : 'user',
        parts: [{text: msg.text}]
    }));
    
    let prompt;
    switch(stage) {
        case 'OPENING':
            prompt = `This is your opening statement. Based on your stance, present your initial argument regarding the question: "${question}". Make 2 points for the opening statement.`;
            break;
        case 'REBUTTAL':
            prompt = `This is your rebuttal. Directly address your opponent's last point and present your counter-argument.`;
            break;
        case 'CLOSING':
            prompt = `This is your closing statement. Summarize your key arguments and deliver a final, persuasive conclusion. Do not introduce new arguments.`;
            break;
        default:
            // Fallback, though it shouldn't be reached with the new structure
            prompt = `Continue the debate by responding to the previous point.`;
    }


    const chat = ai.chats.create({
        model: 'gemini-2.5-flash',
        config: { systemInstruction },
        history: chatHistory
    });

    return chat.sendMessageStream({ message: prompt });
};

export const generateDebateSummary = async (debateHistory: DebateMessage[]): Promise<{ logosSummary: string[], pathosSummary: string[] }> => {
    const debateTranscript = debateHistory
        .filter(msg => msg.persona !== 'SYSTEM')
        .map(msg => `${msg.persona}: ${msg.text}`)
        .join('\n');

    const prompt = `Based on the following debate transcript, summarize the key arguments for each debater, Logos and Pathos. Provide exactly 3 bullet points for each.

Debate Transcript:
---
${debateTranscript}
---

Provide the summary in a JSON format with two keys: "logosSummary" and "pathosSummary". Each key should contain an array of strings, where each string is a concise bullet point.`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        logosSummary: {
                            type: Type.ARRAY,
                            description: "An array of strings summarizing Logos's key arguments.",
                            items: { type: Type.STRING }
                        },
                        pathosSummary: {
                            type: Type.ARRAY,
                            description: "An array of strings summarizing Pathos's key arguments.",
                            items: { type: Type.STRING }
                        }
                    },
                    required: ['logosSummary', 'pathosSummary']
                }
            }
        });

        const jsonText = response.text.trim();
        return JSON.parse(jsonText);
    } catch (error) {
        console.error("Error generating debate summary:", error);
        throw new Error("Could not generate the debate summary.");
    }
};


const personaVoices: Record<AIPersona, string> = {
    [AIPersona.Logos]: 'Puck', // A calm, steady voice
    [AIPersona.Pathos]: 'Kore', // A more expressive voice
};

export const generateSpeech = async (text: string, persona: AIPersona): Promise<string> => {
    try {
        const response: GenerateContentResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash-preview-tts",
            contents: [{ parts: [{ text }] }],
            config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: personaVoices[persona] },
                    },
                },
            },
        });
        const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!base64Audio) {
            throw new Error("No audio data received from API.");
        }
        return base64Audio;
    } catch(error) {
        console.error("Error generating speech:", error);
        throw new Error("Failed to generate audio for the debate.");
    }
};