
import { GoogleGenAI, Type, GenerateContentResponse, Chat, Modality } from "@google/genai";
import { AIPersona, DebateMessage, ArgumentComparison, Score } from '../types';

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
  [AIPersona.Logos]: (side: string) => `You are an AI debater named Logos. Your persona is based on logic, data, and utilitarian principles. You are calm, rational, and analytical. You must argue for this stance: "${side}". You MUST use your search tool to find and cite sources for your claims. Structure your arguments clearly. Your response MUST be concise, around 75 words, suitable for a 30-second spoken turn.`,
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

    const isLogos = persona === AIPersona.Logos;
    const config: any = { systemInstruction };

    // Only add the search tool for the Logos persona
    if (isLogos) {
        config.tools = [{ googleSearch: {} }];
    }

    const chat = ai.chats.create({
        model: 'gemini-2.5-flash',
        config: config,
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

export const generateArgumentComparison = async (debateHistory: DebateMessage[]): Promise<ArgumentComparison[]> => {
    const debateTranscript = debateHistory
        .filter(msg => msg.persona !== 'SYSTEM')
        .map(msg => `${msg.persona}: ${msg.text}`)
        .join('\n');

    const prompt = `Based on the following debate transcript, create a table comparing the main arguments presented by Logos and Pathos on key topics. Identify 3-4 core points of contention.

Debate Transcript:
---
${debateTranscript}
---

Provide the comparison in a JSON format. It should be an array of objects, where each object has three keys: "topic", "logosStance", and "pathosStance".`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            topic: {
                                type: Type.STRING,
                                description: "The core topic or point of contention."
                            },
                            logosStance: {
                                type: Type.STRING,
                                description: "A concise summary of Logos's position on the topic."
                            },
                            pathosStance: {
                                type: Type.STRING,
                                description: "A concise summary of Pathos's position on the topic."
                            }
                        },
                        required: ['topic', 'logosStance', 'pathosStance']
                    }
                }
            }
        });

        const jsonText = response.text.trim();
        return JSON.parse(jsonText);
    } catch (error) {
        console.error("Error generating argument comparison:", error);
        throw new Error("Could not generate the argument comparison table.");
    }
};

export const generateDebateScore = async (debateHistory: DebateMessage[], question: string): Promise<{ logos: Score[], pathos: Score[] }> => {
    const debateTranscript = debateHistory
        .filter(msg => msg.persona !== 'SYSTEM')
        .map(msg => `${msg.persona}: ${msg.text}`)
        .join('\n');

    const prompt = `You are an impartial and expert debate judge. Your task is to analyze the following debate transcript on the topic "${question}" and score both participants, Logos and Pathos, based on a detailed rubric.

Debate Transcript:
---
${debateTranscript}
---

Grading Rubric:
Please score each debater on a scale of 0 to 5 for each of the following criteria. Provide brief notes (one sentence) justifying your score for each criterion. The criteria are, in order: Positioning, Argument, Evidence, Refutation, Coverage, Ethics, Clarity, Tone.

1.  **Positioning (10%):** How well did they establish and maintain their stance?
2.  **Argument (20%):** How logical and well-structured were their arguments?
3.  **Evidence (20%):** How effectively did they use facts, data, or sources to support their claims? (Note: For Pathos, who uses emotional appeals, score based on the effectiveness and relevance of their appeals).
4.  **Refutation (15%):** How well did they address and counter their opponent's points?
5.  **Coverage (10%):** Did they address the core aspects of the question?
6.  **Ethics (10%):** Did they handle the ethical dimensions of the topic with nuance?
7.  **Clarity (10%):** How clear and understandable were their points?
8.  **Tone (5%):** Was their tone appropriate and effective for their persona?

Provide your response in the specified JSON format.`;

    const scoreItemSchema = {
        type: Type.OBJECT,
        properties: {
            criteria: { type: Type.STRING },
            score: { type: Type.NUMBER, description: "A score from 0 to 5." },
            notes: { type: Type.STRING, description: "Brief justification for the score, one sentence." }
        },
        required: ['criteria', 'score', 'notes']
    };

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        logos: {
                            type: Type.ARRAY,
                            description: "An array of 8 scores for the Logos persona, following the rubric order.",
                            items: scoreItemSchema
                        },
                        pathos: {
                            type: Type.ARRAY,
                            description: "An array of 8 scores for the Pathos persona, following the rubric order.",
                            items: scoreItemSchema
                        }
                    },
                    required: ['logos', 'pathos']
                }
            }
        });
        const jsonText = response.text.trim();
        const parsed = JSON.parse(jsonText);
        return { logos: parsed.logos, pathos: parsed.pathos };
    } catch (error) {
        console.error("Error generating debate score:", error);
        throw new Error("Could not generate the debate score.");
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
