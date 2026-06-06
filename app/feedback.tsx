import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Modal,
  FlatList,
  ActivityIndicator,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import axios from "axios";
import BottomNavBar from "../components/BottomNavBar";
import TopBar from "../components/TopBar";
import { API_URL } from "../utils/config";
import { useAuth } from "./context/AuthContext";
import { useNotifications } from "./context/NotificationContext";

export default function FeedbackScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { addNotification } = useNotifications();

  const [rating, setRating] = useState(0);
  const [message, setMessage] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [feedbacks, setFeedbacks] = useState<any[]>([]);
  const [loadingFeedbacks, setLoadingFeedbacks] = useState(false);

  const loadFeedbacks = async () => {
    try {
      setLoadingFeedbacks(true);
      const resp = await axios.get(`${API_URL}/feedback?limit=50`);
      if (resp.data?.feedbacks) {
        setFeedbacks(resp.data.feedbacks);
      } else {
        setFeedbacks([]);
      }
    } catch (err) {
      console.error("Failed to load feedbacks", err);
      setFeedbacks([]);
    } finally {
      setLoadingFeedbacks(false);
    }
  };

  useEffect(() => {
    loadFeedbacks();
  }, []);

  const handleSubmit = async () => {
    if (rating === 0) {
      alert("Please select a star rating");
      return;
    }

    try {
      const response = await axios.post(
        `${API_URL}/feedback`,
        {
          rating,
          message,
          userId: user?.uid,
          email: user?.email,
          displayName: user?.displayName,
        }
      );

      if (response.data.success) {
        addNotification({
          title: "Feedback Submitted",
          text: "Thanks for your feedback. We appreciate your time.",
          type: "note",
        });
        setShowModal(true);
        setRating(0);
        setMessage("");
        await loadFeedbacks();
      } else {
        alert("Failed to submit feedback");
      }
    } catch (err) {
      console.error(err);
      alert(
        "Error submitting feedback. Make sure your backend is running and reachable."
      );
    }
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.container}>
        <TopBar
          showBack
          title="Feedback"
          onBackPress={() => router.back()}
          onBellPress={() => router.push("/notifications" as any)}
        />

        {/* Content */}
        <View style={styles.content}>
          <Text style={styles.title}>How Do You Like Our App?</Text>
          <Text style={styles.subtitle}>
            Please rate our funeral services and share your feedback.
          </Text>

          {/* ⭐ Star Rating */}
          <View style={styles.starRow}>
            {[1, 2, 3, 4, 5].map((star) => (
              <TouchableOpacity key={star} onPress={() => setRating(star)}>
                <Text
                  style={[
                    styles.star,
                    star <= rating ? styles.starActive : styles.starInactive,
                  ]}
                >
                  ★
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Message */}
          <Text style={styles.label}>Message (Optional)</Text>
          <TextInput
            style={styles.textArea}
            placeholder="Write your feedback"
            multiline
            value={message}
            onChangeText={setMessage}
          />

          {/* Submit */}
          <TouchableOpacity style={styles.submitButton} onPress={handleSubmit}>
            <Text style={styles.submitText}>Submit</Text>
          </TouchableOpacity>

          {/* Feedback List */}
          <View style={styles.listHeaderRow}>
            <Text style={styles.listHeader}>Recent Feedback</Text>
            <TouchableOpacity onPress={loadFeedbacks}>
              <Text style={styles.refreshText}>Refresh</Text>
            </TouchableOpacity>
          </View>

          {loadingFeedbacks ? (
            <ActivityIndicator style={{ marginTop: 10 }} color="#2b0e05" />
          ) : (
            <FlatList
              style={styles.feedbackList}
              data={feedbacks}
              keyExtractor={(item) => item.id || `${item.email || "anon"}-${Math.random()}`}
              renderItem={({ item }) => {
                const displayName = item.displayName || item.email || "Anonymous";
                const initial = displayName.charAt(0).toUpperCase();
                const stars = "★".repeat(item.rating) + "☆".repeat(5 - item.rating);
                
                return (
                  <View style={styles.feedbackCard}>
                    <View style={styles.feedbackHeader}>
                      <View style={styles.avatarCircle}>
                        <Text style={styles.avatarText}>{initial}</Text>
                      </View>
                      <View style={styles.feedbackHeaderText}>
                        <Text style={styles.feedbackName}>{displayName}</Text>
                        <Text style={styles.feedbackStars}>{stars}</Text>
                      </View>
                    </View>
                    {item.message ? (
                      <Text style={styles.feedbackMessage}>{item.message}</Text>
                    ) : (
                      <Text style={styles.feedbackNoMessage}>No comment provided</Text>
                    )}
                  </View>
                );
              }}
              ListEmptyComponent={
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptyText}>No feedback yet.</Text>
                  <Text style={styles.emptySubtext}>Be the first to share your experience!</Text>
                </View>
              }
              contentContainerStyle={styles.feedbackListContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            />
          )}
        </View>
      </View>

      {/* ✅ Success Modal */}
      <Modal transparent visible={showModal} animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            {/* Close Button */}
            <TouchableOpacity
              style={styles.closeIcon}
              onPress={() => setShowModal(false)}
            >
              <Text style={styles.closeText}>✕</Text>
            </TouchableOpacity>

            {/* Check Icon */}
            <View style={styles.checkCircle}>
              <Text style={styles.checkMark}>✓</Text>
            </View>

            <Text style={styles.modalText}>
              Feedback submitted successfully
            </Text>
          </View>
        </View>
      </Modal>

      {/* Bottom Navbar */}
      <BottomNavBar activeTab="Feedback" />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff8ef" },

  content: { flex: 1, padding: 20, paddingBottom: 0 },
  title: { fontSize: 18, fontWeight: "600", marginBottom: 6 },
  subtitle: { fontSize: 14, color: "#666", marginBottom: 20 },

  starRow: {
    flexDirection: "row",
    justifyContent: "center",
    marginBottom: 25,
  },
  star: { fontSize: 36, marginHorizontal: 6 },
  starActive: { color: "#f5a623" },
  starInactive: { color: "#ccc" },

  label: { fontSize: 14, marginBottom: 6, fontWeight: "500" },
  textArea: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 16,
    padding: 12,
    height: 100,
    textAlignVertical: "top",
    marginBottom: 20,
  },

  submitButton: {
    backgroundColor: "#2b0e05",
    paddingVertical: 14,
    borderRadius: 999,
    width: 140,
  },
  submitText: {
    color: "#fff",
    fontWeight: "600",
    textAlign: "center",
  },

  listHeaderRow: {
    marginTop: 24,
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  listHeader: {
    fontSize: 16,
    fontWeight: "600",
    color: "#2b0e05",
  },
  refreshText: {
    color: "#2b0e05",
    fontWeight: "600",
  },
  feedbackList: {
    flex: 1,
    minHeight: 0,
  },
  feedbackListContent: {
    flexGrow: 1,
    paddingBottom: 120,
  },
  feedbackCard: {
    padding: 16,
    borderRadius: 16,
    marginBottom: 14,
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
    borderWidth: 1,
    borderColor: "#f0f0f0",
  },
  feedbackHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
  },
  avatarCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#2b0e05",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  avatarText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
  },
  feedbackHeaderText: {
    flex: 1,
  },
  feedbackName: {
    fontSize: 15,
    fontWeight: "600",
    color: "#2b0e05",
    marginBottom: 2,
  },
  feedbackStars: {
    fontSize: 16,
    color: "#f5a623",
    letterSpacing: 2,
  },
  feedbackMessage: {
    fontSize: 14,
    color: "#444",
    lineHeight: 20,
    fontStyle: "italic",
  },
  feedbackNoMessage: {
    fontSize: 13,
    color: "#aaa",
    fontStyle: "italic",
  },
  emptyContainer: {
    alignItems: "center",
    marginTop: 40,
    paddingHorizontal: 20,
  },
  emptyText: {
    fontSize: 16,
    color: "#999",
    fontWeight: "600",
    marginBottom: 6,
  },
  emptySubtext: {
    fontSize: 14,
    color: "#bbb",
    textAlign: "center",
  },

  /* Modal */
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
  },

  modalBox: {
    width: 260,
    height: 260,
    backgroundColor: "#fff",
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },

  closeIcon: {
    position: "absolute",
    top: 14,
    right: 14,
    zIndex: 10,
  },

  closeText: {
    fontSize: 20,
    color: "#333",
  },

  checkCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "#2ecc71",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 20,
  },

  checkMark: {
    color: "#fff",
    fontSize: 40,
    fontWeight: "bold",
  },

  modalText: {
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
    color: "#333",
  },
});
