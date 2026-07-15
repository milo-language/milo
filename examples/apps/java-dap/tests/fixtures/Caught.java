public class Caught {
    public static void main(String[] args) {
        try {
            throw new IllegalStateException("boom message");
        } catch (IllegalStateException e) {
            System.out.println("caught: " + e.getMessage());
        }
    }
}
