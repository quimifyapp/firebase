const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');
const {TranslationServiceClient} = require('@google-cloud/translate');

admin.initializeApp();
const db = admin.firestore();

const textOpenAI = new OpenAI({
  apiKey: functions.config().openai.key
});

const imageOpenAI = new OpenAI({
  apiKey: functions.config().openai.key
});

exports.extractTextFromImage = functions
  .region('us-central1')
  .runWith({
    timeoutSeconds: 300,
    memory: '1GB'
  })
  .https.onCall(async (data, context) => {
    try {
      const { imageBase64 } = data;

      if (!imageBase64) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'The function must be called with imageBase64.'
        );
      }

      const base64Image = imageBase64.replace(/^data:image\/\w+;base64,/, '');

      const response = await imageOpenAI.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "You are a text extraction tool. Your only job is to read and return the exact text from images. Do not add any explanations, descriptions, or additional context. Just return the text exactly as it appears in the image."
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Extract and return only the text from this image, exactly as it appears." },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`,
                },
              },
            ],
          },
        ],
        max_tokens: 1000,
      });

      return {
        success: true,
        text: response.choices[0].message.content,
      };
    } catch (error) {
      console.error('Error:', error);
      throw new functions.https.HttpsError('internal', error.message);
    }
  });

exports.processChat = functions
  .region('us-central1')
  .runWith({
    timeoutSeconds: 300,
    memory: '1GB'
  })
  .https.onCall(async (data, context) => {
    const maxNumberOfMessages = 20;

    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'The function must be called while authenticated.'
      );
    }

    const userId = context.auth.uid;
    const { message, imageBase64, messageType = 'text' } = data;

    if (messageType === 'text' && !message) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Text messages must include a message.'
      );
    }

    if (messageType === 'image' && !imageBase64) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Image messages must include an image.'
      );
    }

    try {
      const chatRef = db.collection('chatbot').doc(userId);
      const messagesRef = chatRef.collection('messages');

      // Store the user message
      const userMessageDoc = await messagesRef.add({
        content: message || '',
        messageType,
        isUser: true,
        timestamp: admin.firestore.Timestamp.now(),
        status: 'delivered',
        wasImage: messageType === 'image'
      });

      // Add placeholder for AI response
      const aiMessageDoc = await messagesRef.add({
        content: '',
        isUser: false,
        timestamp: admin.firestore.Timestamp.now(),
        status: 'processing'
      });

      let messages = [];
      let openaiInstance;
      let modelName;

      // Handle differently based on message type
      if (messageType === 'image') {
        openaiInstance = imageOpenAI;
        modelName = 'gpt-4o-mini-2024-07-18';
        // For image messages, only use the current message
        messages = [
          {
            role: 'system',
            content: 'You are Atomic, an AI chemistry teacher integrated into Quimify, a mobile created by Matthew S. Horne and Pablo Asenjo Navas-Parejo, two young entrepreneurs from Málaga, Spain. Quimify helps over 1 million students worldwide, primarily Spanish and English speaking high school students, understand science concepts, especially chemistry. When asked about yourself, your creators, or Quimify, you should answer with the previous context given to you. Keep your responses concise, professional, and focused on the specific question or problem the student presents. Avoid unnecessary information to ensure your replies fit within a 500-token limit. While your primary audience is Spanish and English speaking students, adjust your language and context to suit the users needs. Always aim for clarity and suitability for a high school student audience.'
          },
          {
            role: 'user',
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${imageBase64.replace(/^data:image\/\w+;base64,/, '')}`
                }
              },
              {
                type: "text",
                text: message || "What do you see in this image?"
              }
            ]
          }
        ];
      } else {
        openaiInstance = textOpenAI;
        modelName = 'gpt-4o-mini-2024-07-18';
        // For text messages, get last 20 non-image messages
        const lastMessages = await messagesRef
          .orderBy('timestamp', 'desc')
          .limit(maxNumberOfMessages)
          .get();

        const textMessages = lastMessages.docs
          .map(doc => doc.data())
          .filter(msg => !msg.wasImage) // Exclude image messages
          .reverse()
          .map(msg => ({
            role: msg.isUser ? 'user' : 'assistant',
            content: msg.content
          }));

        messages = [
          {
            role: 'system',
            content: 'You are Atomic, an AI chemistry teacher integrated into Quimify, a mobile created by Matthew S. Horne and Pablo Asenjo Navas-Parejo, two young entrepreneurs from Málaga, Spain. Quimify helps over 1 million students worldwide, primarily Spanish and English speaking high school students, understand science concepts, especially chemistry. When asked about yourself, your creators, or Quimify, you should answer with the previous context given to you. Keep your responses concise, professional, and focused on the specific question or problem the student presents. Avoid unnecessary information to ensure your replies fit within a 500-token limit. While your primary audience is Spanish and English speaking students, adjust your language and context to suit the users needs. Always aim for clarity and suitability for a high school student audience.'
          },
          ...textMessages
        ];
      }

      const completion = await openaiInstance.chat.completions.create({
        model: modelName,
        messages: messages,
        temperature: 0.7,
        max_tokens: 500
      });

      const aiResponse = completion.choices[0]?.message?.content || 'Sorry, I could not generate a response.';

      await aiMessageDoc.update({
        content: aiResponse,
        status: 'completed',
        timestamp: admin.firestore.Timestamp.now()
      });

      await chatRef.set({
        last_interaction: admin.firestore.Timestamp.now(),
        total_messages: admin.firestore.FieldValue.increment(2)
      }, { merge: true });

      return {
        success: true,
        messageId: aiMessageDoc.id
      };

    } catch (error) {
      console.error('Error processing chat:', error);

      if (aiMessageDoc) {
        await aiMessageDoc.update({
          status: 'error',
          content: 'Sorry, an error occurred while processing your message.'
        });
      }

      throw new functions.https.HttpsError('internal', error.message);
    }
  });

// Process practice mode answers and update leaderboard
exports.processPracticeModeAnswers = functions
  .region('us-central1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'The function must be called while authenticated.'
      );
    }

    const userId = context.auth.uid;
    const { answers, userName } = data;
    const userDisplayName = context.auth.token.name || userName;

    console.log('Received answers:', answers);
    console.log('User name:', userDisplayName);
    console.log('User ID:', userId);

    if (!answers || !Array.isArray(answers)) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Answers must be provided as an array.'
      );
    }

    if (!userDisplayName) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'User name must be provided either in auth token or as a parameter.'
      );
    }

    try {
      // Read the CSV file
      const csvPath = path.join(__dirname, 'data', 'practice_mode_questions.csv');
      const csvContent = fs.readFileSync(csvPath, 'utf-8');
      
      // Parse CSV content
      const questions = {};
      const rows = csvContent.split('\n').slice(1); // Skip header
      rows.forEach(row => {
        const [id, , , , , , solution] = row.split(',');
        if (id && solution) {
          questions[id] = solution.trim();
        }
      });

      // Calculate points
      let totalPoints = 0;
      answers.forEach(({ id, answer }) => {
        console.log(`Question ID: ${id}, Answer: ${answer}, Solution: ${questions[id]}`);
        if (questions[id] && questions[id] === answer) {
          totalPoints += 1000;
        }
      });

      // Update leaderboard
      const leaderboardRef = db.collection('leaderboard').doc(userId);
      await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(leaderboardRef);
        const currentPoints = doc.exists ? doc.data().points || 0 : 0;
        console.log('Current points:', currentPoints);
        console.log('New points:', totalPoints);
        
        transaction.set(leaderboardRef, {
          points: currentPoints + totalPoints,
          userName: userDisplayName,
          lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      });

      return {
        success: true,
        pointsEarned: totalPoints
      };
    } catch (error) {
      console.error('Error processing practice mode answers:', error);
      throw new functions.https.HttpsError('internal', 'Error processing answers', error);
    }
  });

exports.cleanupUserData = functions.auth.user().onDelete(async (user) => {
    const userId = user.uid;
    const db = admin.firestore();
    
    try {
        // Delete user's chat collection
        const chatRef = db.collection('chatbot').doc(userId);
        
        // First, delete all subcollections if they exist
        const collections = await chatRef.listCollections();
        const deletionPromises = collections.map(async (collection) => {
            const documents = await collection.listDocuments();
            const batch = db.batch();
            
            documents.forEach((doc) => {
                batch.delete(doc);
            });
            
            return batch.commit();
        });

        // Delete user's leaderboard data
        const leaderboardRef = db.collection('leaderboard').doc(userId);
        await leaderboardRef.delete();
        
        // Wait for all subcollections to be deleted
        await Promise.all(deletionPromises);
        
        // Then delete the main chat document
        await chatRef.delete();
        
        console.log(`Successfully deleted chat data for user: ${userId}`);
        
        return {
            success: true,
            message: `All chat data deleted for user: ${userId}`
        };
    } catch (error) {
        console.error(`Error deleting chat data for user ${userId}:`, error);
        
        // Rethrow the error to ensure it's properly logged in Firebase
        throw new functions.https.HttpsError('internal', 'Error deleting user data', error);
    }
});


exports.translateText = functions
  .region('us-central1')
  .runWith({
    timeoutSeconds: 60,
    memory: '256MB'
  })
  .https.onCall(async (data, context) => {

    const { text, language } = data;

    if (!text || !language) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Both text and language must be provided.'
      );
    }

    try {
      // Use explicit service account credentials
      const translate = new TranslationServiceClient({
        keyFilename: path.join(__dirname, 'translation-key.json'),
      });
      
      const projectId = 'quimify-401009';
      const location = 'global';

      const request = {
        parent: `projects/${projectId}/locations/${location}`,
        contents: [text],
        mimeType: 'text/plain',
        targetLanguageCode: language,
      };

      console.log('Translation request:', request);

      const [response] = await translate.translateText(request);
      const translation = response.translations[0];

      return {
        success: true,
        translatedText: translation.translatedText,
        detectedSourceLanguage: translation.detectedLanguageCode || null
      };

    } catch (error) {
      console.error('Error translating text:', error);
      throw new functions.https.HttpsError('internal', error.message);
    }
  });